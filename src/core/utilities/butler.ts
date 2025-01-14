import { Value } from "@zilliqa-js/contract";
import { actions } from "app/store";
import { LayoutState, RootState, TokenInfo, TokenState, Transaction, WalletState } from "app/store/types";
import { strings, useAsyncTask } from "app/utils";
import { DefaultFallbackNetwork, LocalStorageKeys, ZilPayNetworkMap, ZIL_TOKEN_NAME } from "app/utils/constants";
import useStatefulTask from "app/utils/useStatefulTask";
import BigNumber from "bignumber.js";
import { connectWalletPrivateKey, ConnectWalletResult, connectWalletZilPay, parseBalanceResponse } from "core/wallet";
import { RPCResponse, ZilswapConnector } from "core/zilswap";
import { ZWAPRewards } from "core/zwap";
import React, { useEffect, useState } from "react";
import { useDispatch, useSelector, useStore } from "react-redux";
import { ObservedTx, TokenDetails, TxReceipt, TxStatus } from "zilswap-sdk";
import { Network } from "zilswap-sdk/lib/constants";
import { logger } from "./logger";
import { PoolTransaction, ZAPStats } from "./zap-stats";

/**
 * Component constructor properties for {@link AppButler}
 *
 */
export type AppButlerProps = {
};

/**
 * Convert token representation from zilswap-sdk's {@link TokenDetails}
 * to application's {@link TokenInfo}
 *
 * @param zilswapToken token representation from zilswap-sdk
 * @returns mapped {@link TokenInfo} representation of the token.
 */
const mapZilswapToken = (zilswapToken: TokenDetails, network: Network = DefaultFallbackNetwork): TokenInfo => {
  return {
    initialized: false,
    registered: zilswapToken.registered,
    whitelisted: zilswapToken.whitelisted,
    initBalance: false,
    isZil: zilswapToken.address === ZIL_TOKEN_NAME,
    isZwap: zilswapToken.address === ZWAPRewards.TOKEN_CONTRACT[network],
    dirty: false,
    address: zilswapToken.address,
    decimals: zilswapToken.decimals,
    symbol: zilswapToken.symbol,
    name: "",
    // name: zilswapToken.name,
    balance: undefined,
    balances: {},
    allowances: {},
  }
};

/**
 * Converts `Value[]` array to map of string values.
 * `Value.type` is ignored, all values are returned as string.
 *
 *
 * sample input:
 * ```javascript
 *  [{
 *    name: "address",
 *    type: "ByStr20",
 *    value: "0xbadbeef",
 *  }, {
 *    name: "balance",
 *    type: "UInt28",
 *    value: "100000000",
 *  }]
 * ```
 *
 * output:
 * ```javascript
 *  {
 *    address: "0xbadbeef",
 *    balance: "100000000",
 *  }
 * ```
 *
 * @param params parameters in `Value[]` array representation
 * @returns mapped object representation - refer to sample output
 */
export const zilParamsToMap = (params: Value[]): { [index: string]: any } => {
  const output: { [index: string]: any } = {};
  for (const set of params)
    output[set.vname] = set.value;
  return output;
};

// eslint-disable-next-line
let mounted = false;
let zilPayWatcherSubscribed = false;
/**
 * Helper service to run continuous update or polling tasks
 * in the background.
 *
 * *init*:
 *  - initialize TokenState tokens in existing pools on zilswap contract.
 *  - append pseudo-token ZIL for UI implementation convenience.
 *
 * *update*:
 *  - listens to changes in tokens and loads token metadata (pool, balances, etc)
 * for tokens with `initialized` set to `false`.
 *
 */
export const AppButler: React.FC<AppButlerProps> = (props: AppButlerProps) => {
  const walletState = useSelector<RootState, WalletState>(state => state.wallet);
  const layoutState = useSelector<RootState, LayoutState>(state => state.layout);
  const tokenState = useSelector<RootState, TokenState>(state => state.token);
  const store = useStore();
  const [zilswapReady, setZilswapReady] = useState(false);
  const [runQueryToken] = useAsyncTask<void>("queryTokenInfo");
  const [runInitWallet] = useAsyncTask<void>("initWallet");
  const [runInitZilswap] = useAsyncTask<void>("initZilswap");
  const [runReloadTransactions] = useAsyncTask<void>("reloadTransactions");
  const runQueryTokenBalance = useStatefulTask<Partial<TokenInfo>>();
  const dispatch = useDispatch();

  const registerObserver = () => {
    ZilswapConnector.registerObserver((tx: ObservedTx, status: TxStatus, receipt?: TxReceipt) => {
      logger("butler observed tx", tx.hash, status);

      dispatch(actions.Transaction.update({
        hash: tx.hash,
        status: status,
        txReceipt: receipt,
      }));

      // invalidate all tokens if updated TX is currently
      // recorded within state
      const transactions: Transaction[] = store.getState().transaction.transactions;
      if (transactions.find(transaction => transaction.hash === tx.hash))
        dispatch(actions.Token.invalidate());
    });
  };

  const clearObserver = () => {
    ZilswapConnector.registerObserver(null);
  };

  const getConnectedZilPay = async () => {
    const zilPay = (window as any).zilPay;
    try {
      if (typeof zilPay !== "undefined") {
        const result = await zilPay.wallet.connect();
        if (result === zilPay.wallet.isConnect) {
          return zilPay;
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const watchZilPayAccount = (zilPay: any) => {
    if (!zilPay || zilPayWatcherSubscribed) return;

    const accountObserver = zilPay.wallet.observableAccount();
    const networkObserver = zilPay.wallet.observableNetwork();
    accountObserver.subscribe((account: any) => {
      const walletState: WalletState = store.getState().wallet;
      // ignore account change if not connected
      if (!walletState.zilpay) return;

      // re-initialise if account changed
      if (walletState.wallet?.addressInfo.bech32 !== account.bech32) {
        // ZilPay unsubscribes doesnt work
        // accountObserver.unsubscribe();
        // networkObserver.unsubscribe();
        initWithZilPay();
      }
    });
    networkObserver.subscribe(async (net: string) => {
      const walletState: WalletState = store.getState().wallet;
      // ignore account change if not connected
      if (!walletState.zilpay) return;

      const network = ZilPayNetworkMap[net];

      if (!network) {
        // unregistered network
        // run init to handle undefined network
        initWithZilPay();
        return;
      }

      if (network !== ZilswapConnector.network) {
        initWithZilPay();
      }
    });

    zilPayWatcherSubscribed = true;
  };

  const initTokens = () => {
    const zilswapTokens = ZilswapConnector.getTokens();
    const network = ZilswapConnector.network;

    const tokens: { [index: string]: TokenInfo } = {};
    zilswapTokens
      .map((token) => mapZilswapToken(token, network))
      // uncomment to test create pool
      // .filter(token => token.address !== "zil10a9z324aunx2qj64984vke93gjdnzlnl5exygv")
      .forEach((token) => tokens[token.address] = token);

    // initialize store TokenState
    dispatch(actions.Token.init({ tokens }));
  }

  const initZilswap = () => {
    logger("butler", "initZilswap");
    runInitZilswap(async () => {
      initTokens();
      setZilswapReady(true);
    });
  };

  const initWithPrivateKey = (privateKey: string) => {
    logger("butler", "initWithPrivateKey");
    runInitWallet(async () => {
      let walletResult: ConnectWalletResult | undefined;

      try {
        walletResult = await connectWalletPrivateKey(privateKey);
      } catch (e) { }

      const storeState: RootState = store.getState();
      if (walletResult?.wallet) {
        const { wallet } = walletResult;

        await ZilswapConnector.connect({
          wallet,
          network: storeState.layout.network,
          observedTxs: storeState.transaction.observingTxs,
        });
        dispatch(actions.Wallet.update({ wallet, privateKey }));
      } else {
        await ZilswapConnector.initialise({
          network: storeState.layout.network,
        });
        dispatch(actions.Wallet.update({ wallet: undefined, privateKey: undefined, zilpay: undefined }));
      }

      initZilswap();
    });
  };

  const initWithZilPay = () => {
    logger("butler", "initWithZilPay");
    runInitWallet(async () => {
      let walletResult: ConnectWalletResult | undefined;
      const zilPay = await getConnectedZilPay();
      if (zilPay) {
        try {
          walletResult = await connectWalletZilPay(zilPay);
          watchZilPayAccount(zilPay);
        } catch (e) {
          dispatch(actions.Layout.updateNotification({
            type: "",
            message: e.message,
          }));
        }
      }

      const storeState: RootState = store.getState();
      if (walletResult?.wallet) {
        const { wallet } = walletResult;
        const { network } = wallet;
        await ZilswapConnector.connect({
          wallet,
          network,
          observedTxs: storeState.transaction.observingTxs,
        });
        dispatch(actions.Layout.updateNetwork(network));
        dispatch(actions.Wallet.update({ wallet, zilpay: true }));
      } else {
        await ZilswapConnector.initialise({
          network: storeState.layout.network,
        });
        dispatch(actions.Wallet.update({ wallet: undefined, privateKey: undefined, zilpay: undefined }));
      }

      initZilswap();
    });
  };

  const initWithoutWallet = () => {
    logger("butler", "initWithoutWallet");
    runInitWallet(async () => {
      const storeState: RootState = store.getState();
      await ZilswapConnector.initialise({
        network: storeState.layout.network,
      });
      dispatch(actions.Wallet.update({ wallet: undefined, privateKey: undefined, zilpay: undefined }));

      initZilswap();
    });
  };

  useEffect(() => {
    logger("butler mount");
    registerObserver();

    const privateKey = localStorage.getItem(LocalStorageKeys.PrivateKey);
    const savedZilpay = localStorage.getItem(LocalStorageKeys.ZilPayConnected);

    if (typeof privateKey === "string") {
      initWithPrivateKey(privateKey);
    } else if (savedZilpay === "true") {
      initWithZilPay();
    } else {
      initWithoutWallet();
    }

    mounted = true;
    return () => {
      mounted = false;
      clearObserver();
    };

    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    logger("butler", "zilswapReady", { zilswapReady, wallet: walletState.wallet, zilpay: walletState.zilpay });
    if (!zilswapReady) return;

    if (walletState.wallet) {
      if (walletState.zilpay) {
        watchZilPayAccount(walletState.wallet.provider);
      }

      runReloadTransactions(async () => {
        if (!walletState.wallet) return;
        const { records } = await ZAPStats.getPoolTransactions({
          network: ZilswapConnector.network!,
          address: walletState.wallet!.addressInfo.bech32,
          per_page: 50,
        });
        const transactions: Transaction[] = records.map((tx: PoolTransaction) => ({
          hash: tx.transaction_hash,
          status: "confirmed",
        }));

        dispatch(actions.Transaction.init({ transactions }));
      });
    } else {
      dispatch(actions.Transaction.init({ transactions: [] }));
    }

    dispatch(actions.Token.invalidate());
    // eslint-disable-next-line
  }, [zilswapReady, walletState.wallet]);

  useEffect(() => {
    logger("butler", "network change")
    if (zilswapReady) initTokens();

    // eslint-disable-next-line
  }, [layoutState.network])

  useEffect(() => {

    const tokens: TokenInfo[] = store.getState().token.tokens;
    for (const address in tokens) {
      const token = tokens[address];

      // skip initialized tokens to prevent run away
      // update cycle by useEffect.
      if (token.initialized && !token.dirty) continue;
      logger(`butler update:${token.symbol}`);

      // set initialized to true to prevent repeat execution
      // due to useEffect triggering.
      // set loading to true for UI implementations.
      dispatch(actions.Token.update({
        address,
        loading: true,
        dirty: false,
        initialized: true,
      }));

      runQueryToken(async () => {
        // zil is a pseudo token that should be updated through
        // updating the connected wallet.

        const walletAddress = walletState.wallet?.addressInfo.byte20;
        const lowerCaseWalletAddress = walletAddress?.toLowerCase() || "";
        if (token.isZil) {
          let balance: BigNumber | undefined;
          if (walletAddress) {
            const balanceRPCResponse = await ZilswapConnector.getZilliqa().blockchain.getBalance(walletAddress);
            const balanceResult = parseBalanceResponse(balanceRPCResponse as RPCResponse<any, string>);
            balance = strings.bnOrZero(balanceResult.balance);
          }

          // update token store
          dispatch(actions.Token.update({
            name: "Zilliqa",
            address,
            balance,
            loading: false,
            balances: {
              ...balance && {
                // initialize with own wallet balance
                [walletState.wallet!.addressInfo.byte20.toLowerCase()]: balance!,
              },
            },
          }));
          return;
        }

        const tokenDetails = ZilswapConnector.getToken(address);

        let { initBalance, balance, balances, allowances, name } = token;

        if (initBalance || token.isZwap) {
          const result = await runQueryTokenBalance(async () => {
            if (!name) {
              const contractInitParams = await tokenDetails?.contract.getInit();
              if (contractInitParams) {
                const contractInit = zilParamsToMap(contractInitParams);
                name = contractInit.name;
              }
            }

            // load token balance
            const contractBalanceState = await ZilswapConnector.loadBalanceState(token.address)
            // map balance object from string values to BN values
            balances = {};
            for (const address in contractBalanceState)
              balances[address] = strings.bnOrZero(contractBalanceState[address]);

            balance = strings.bnOrZero(balances[lowerCaseWalletAddress]);

            // load token allowances to check if unlock is necessary
            const allowancesState = await ZilswapConnector.loadAllowances(token.address)
            allowances = allowancesState?.[lowerCaseWalletAddress] || {};

            return { balance, balances, allowances, name }
          }, `rueryTokenBalance-${token.address}`);

          balance = result.balance
          balances = result.balances
          allowances = result.allowances
          name = result.name
        }

        // retrieve token pool, if it exists
        const pool = ZilswapConnector.getPool(token.address) || undefined;

        // prepare and dispatch token info update to store.
        const tokenInfo: TokenInfo = {
          initialized: true,
          dirty: false,
          loading: false,
          isZil: false,
          isZwap: token.isZwap,
          initBalance, name,

          registered: token.registered,
          whitelisted: token.whitelisted,
          address: token.address,
          decimals: token.decimals,

          symbol: tokenDetails?.symbol ?? '',

          pool, balance, balances, allowances,
        };
        dispatch(actions.Token.update(tokenInfo));
      });
    }

    // eslint-disable-next-line
  }, [tokenState.tokens]);

  return null;
};
