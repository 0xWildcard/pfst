import React, { useEffect, useState, useCallback, useMemo } from 'react';
import axios from 'axios';
import './App.css';  // Import your CSS file

const ALCHEMY_API_URL = 'https://solana-mainnet.g.alchemy.com/v2/SjJUD_yrq-FwoP17v2YFizkf2Yryoygu';
const EXTRNODE_API_URL = 'https://solana-mainnet.rpc.extrnode.com/c30b36be-ed29-4cc3-946b-21a7a785398e';

function App() {
    const [loading, setLoading] = useState(true);
    const [targetedTransactions, setTargetedTransactions] = useState([]);
    const [statusMessage, setStatusMessage] = useState('');
    const [lastFetchedSignature, setLastFetchedSignature] = useState(null);
    const processedTransactionIds = useMemo(() => new Set(), []); // Track processed transaction IDs
    const seenTokenAddresses = useMemo(() => new Set(), []); // Track processed token addresses

    const MINTER_ADDRESS = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
    const INITIAL_SIGNATURE_FETCH_LIMIT = 30;
    const STANDARD_SIGNATURE_FETCH_LIMIT = 5;
    const STANDARD_POLLING_INTERVAL_MS = 3000;

    const TARGET_DATA_BASE64 = useMemo(() => [
        '3mimF1vf45io',
        '3ipZWcvdfi4ZMA2h6UPodC5qTfD9CpLKxRF23SBNGvo9LygWEGQyStb2TpFf'
    ], []);

    const fetchSignatures = useCallback(async (limit) => {
        try {
            const response = await axios.post(ALCHEMY_API_URL, {
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignaturesForAddress',
                params: [
                    MINTER_ADDRESS,
                    { limit }
                ]
            });

            if (response.data.result) {
                return response.data.result.map(sig => sig.signature);
            } else {
                return [];
            }
        } catch (error) {
            setStatusMessage('Error fetching signatures.');
            console.error('Error fetching signatures:', error);
            return [];
        }
    }, []);

    const fetchTokenMetadata = useCallback(async (mintAddress) => {
        try {
            const response = await axios.post(EXTRNODE_API_URL, {
                jsonrpc: '2.0',
                id: 1,
                method: 'getAsset',
                params: [mintAddress]
            });

            if (response.data && response.data.result) {
                return response.data.result;
            } else {
                console.warn(`No metadata found for token address: ${mintAddress}`);
                return null;
            }
        } catch (error) {
            console.error(`Error fetching metadata for token: ${mintAddress}`, error);
            return null;
        }
    }, []);

    const fetchTransaction = useCallback(async (transactionId, retryCount = 0) => {
        try {
            const response = await axios.post(ALCHEMY_API_URL, {
                jsonrpc: '2.0',
                id: 1,
                method: 'getTransaction',
                params: [
                    transactionId,
                    {
                        commitment: 'confirmed',
                        encoding: 'json',
                        maxSupportedTransactionVersion: 0
                    }
                ]
            });

            if (response.data.result) {
                const transaction = response.data.result;

                const tokenAddress = transaction.transaction.message.accountKeys[19];
                const liquidityPairAddress = transaction.transaction.message.accountKeys[2];

                if (seenTokenAddresses.has(tokenAddress)) {
                    return null; // Skip duplicate tokens
                }

                let metadata = null;
                if (tokenAddress) {
                    metadata = await fetchTokenMetadata(tokenAddress);
                    if (metadata) {
                        seenTokenAddresses.add(tokenAddress);
                    }
                } else {
                    console.warn(`Token address is undefined for transaction: ${transactionId}`);
                }

                return { transaction, tokenAddress, liquidityPairAddress, metadata };
            } else {
                return null;
            }
        } catch (error) {
            if (error.response && error.response.status === 429 && retryCount < 5) {
                console.warn(`429 error, retrying after delay (${retryCount + 1}/5)...`);
                await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1)));
                return fetchTransaction(transactionId, retryCount + 1);
            } else {
                console.error('Error fetching the transaction:', error);
                return null;
            }
        }
    }, [fetchTokenMetadata, seenTokenAddresses]);

    const isTargetedTransaction = useCallback((transaction) => {
        if (!transaction || !transaction.transaction || !transaction.transaction.message) return false;

        const instructions = transaction.transaction.message.instructions;

        const matchesTargetData = instructions.some(instruction => 
            TARGET_DATA_BASE64.some(target => instruction.data.startsWith(target))
        );

        const matchingAccountStructure = transaction.meta && transaction.meta.postBalances && transaction.meta.postBalances.length === 23;

        const significantBalanceChange = transaction.meta && transaction.meta.postBalances && transaction.meta.postBalances[0] > 1600000000000;

        return matchesTargetData && matchingAccountStructure && significantBalanceChange;
    }, [TARGET_DATA_BASE64]);

    const pollTransactions = useCallback(async (limit) => {
        console.log(`Polling for ${limit} new transactions...`);
        const signatures = await fetchSignatures(limit);

        if (!signatures.length) {
            console.log('No new signatures found.');
            return;
        }

        const newTransactions = [];

        for (const signature of signatures) {
            if (signature === lastFetchedSignature) break;

            const result = await fetchTransaction(signature);

            if (result && isTargetedTransaction(result.transaction)) {
                console.log(`Transaction ${result.transaction.transaction.signatures[0]} matches the criteria`);
                console.log(`Token Address: ${result.tokenAddress}`);
                console.log(`Liquidity Pair Address: ${result.liquidityPairAddress}`);
                console.log(`Token Metadata:`, result.metadata);

                if (!processedTransactionIds.has(result.transaction.transaction.signatures[0])) {
                    newTransactions.push(result);
                    processedTransactionIds.add(result.transaction.transaction.signatures[0]);
                }
            }
        }

        if (newTransactions.length > 0) {
            console.log(`Found ${newTransactions.length} new targeted transactions.`);
            setTargetedTransactions(t => {
                const updatedTransactions = [...newTransactions, ...t].slice(0, 5);
                return updatedTransactions.sort((a, b) => b.transaction.blockTime - a.transaction.blockTime);
            });
            setLastFetchedSignature(signatures[0]);
            setLoading(false);
        } else {
            console.log('No new targeted transactions found.');
        }
    }, [fetchSignatures, fetchTransaction, isTargetedTransaction, lastFetchedSignature, processedTransactionIds]);

    useEffect(() => {
        const fetchInitialTransactions = async () => {
            await pollTransactions(INITIAL_SIGNATURE_FETCH_LIMIT);

            const intervalId = setInterval(() => {
                pollTransactions(STANDARD_SIGNATURE_FETCH_LIMIT);
            }, STANDARD_POLLING_INTERVAL_MS);

            return () => clearInterval(intervalId);
        };

        fetchInitialTransactions();
    }, [pollTransactions]);

    return (
        <div className="App">
            <header className="App-header">
                <h1>Latest Pump.Fun Raydium Launches</h1>
                <p>{statusMessage}</p>
                {loading ? (
                    <p>Loading...</p>
                ) : (
                    <div>
                        {targetedTransactions.length > 0 ? (
                            targetedTransactions.map((result, index) => (
                                <div key={index} className="transaction-item new">
                                    {result.metadata?.content?.links?.image && (
                                        <img
                                            src={result.metadata.content.links.image}
                                            alt={result.metadata.content.metadata?.name || "Token Image"}
                                            className="transaction-image"
                                        />
                                    )}
                                    <h2 className="transaction-name">{result.metadata?.content?.metadata?.name || "Unknown Token"}</h2>
                                    <p className="transaction-time">Launch Time: {result.transaction.blockTime ? new Date(result.transaction.blockTime * 1000).toLocaleString() : 'N/A'}</p>
                                    <p className="transaction-symbol">Symbol: {result.metadata?.content?.metadata?.symbol || "N/A"}</p>
                                    <p className="transaction-token-address">{result.tokenAddress}</p>
                                    <div className="button-group transaction-buttons">
                                        <button className="link-button" onClick={() => window.open(`https://pump.fun/${result.tokenAddress}`, '_blank')}>
                                            Pump Fun
                                        </button>
                                        <button className="link-button" onClick={() => window.open(`https://dexscreener.com/solana/${result.liquidityPairAddress}`, '_blank')}>
                                            Dex<br />Screener
                                        </button>
                                        <button className="link-button" onClick={() => window.open(`https://www.geckoterminal.com/solana/pools/${result.liquidityPairAddress}`, '_blank')}>
                                            Gecko<br />Terminal
                                        </button>
                                        <button className="link-button" onClick={() => window.open(`https://solscan.io/tx/${result.transaction.transaction.signatures[0]}`, '_blank')}>
                                            Solscan
                                        </button>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <p>No targeted transactions found.</p>
                        )}
                    </div>
                )}
            </header>
        </div>
    );
}

export default App;


