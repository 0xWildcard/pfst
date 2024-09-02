import React, { useEffect, useState, useCallback, useMemo } from 'react';
import axios from 'axios';
import './App.css';  // Import your CSS file

const ALCHEMY_API_URL = 'https://solana-mainnet.g.alchemy.com/v2/SjJUD_yrq-FwoP17v2YFizkf2Yryoygu';
const GECKO_TERMINAL_API_URL = 'https://api.geckoterminal.com/api/v2';

function App() {
    const [loading, setLoading] = useState(true);
    const [targetedTransactions, setTargetedTransactions] = useState([]);
    const [statusMessage, setStatusMessage] = useState('');
    const [lastFetchedSignature, setLastFetchedSignature] = useState(null);
    const processedTransactionIds = useMemo(() => new Set(), []); // Track processed transaction IDs

    const MINTER_ADDRESS = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
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

    const fetchGeckoTerminalMetadata = useCallback(async (mintAddress) => {
        try {
            const response = await axios.get(`${GECKO_TERMINAL_API_URL}/networks/solana/tokens/${mintAddress}`);
            if (response.data && response.data.data) {
                const { attributes } = response.data.data;
                return {
                    name: attributes.name,
                    symbol: attributes.symbol,
                    logoURI: attributes.logo
                };
            } else {
                console.warn(`Metadata not found for token: ${mintAddress}`);
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

                let metadata = null;
                if (tokenAddress) {
                    metadata = await fetchGeckoTerminalMetadata(tokenAddress);
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
    }, [fetchGeckoTerminalMetadata]);

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
            await pollTransactions(STANDARD_SIGNATURE_FETCH_LIMIT);

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
                <h1>Testing Recent Transactions</h1>
                <p>{statusMessage}</p>
                {loading ? (
                    <p>Loading...</p>
                ) : (
                    <div>
                        <h2>Targeted Transactions Found:</h2>
                        {targetedTransactions.length > 0 ? (
                            targetedTransactions.map((result, index) => (
                                <div key={index} className="transaction-item new">
                                    <strong>Block Time:</strong> {result.transaction.blockTime ? new Date(result.transaction.blockTime * 1000).toLocaleString() : 'N/A'}<br />
                                    <strong>Token Name:</strong> {result.metadata.name}<br />
                                    <strong>Token Symbol:</strong> {result.metadata.symbol}<br />
                                    <strong>Token Address:</strong> <a href={`https://pump.fun/${result.tokenAddress}`} target="_blank" rel="noopener noreferrer">{result.tokenAddress}</a><br />
                                    <strong>Liquidity Pair Address:</strong> <a href={`https://dexscreener.com/solana/${result.liquidityPairAddress}`} target="_blank" rel="noopener noreferrer">{result.liquidityPairAddress}</a><br />
                                    <strong>GeckoTerminal Pool:</strong> <a href={`https://www.geckoterminal.com/solana/pools/${result.liquidityPairAddress}`} target="_blank" rel="noopener noreferrer">{result.liquidityPairAddress}</a><br />
                                    <strong>Transaction ID:</strong> <a href={`https://solscan.io/tx/${result.transaction.transaction.signatures[0]}`} target="_blank" rel="noopener noreferrer">{result.transaction.transaction.signatures[0]}</a><br />
                                    {result.metadata.logoURI && <img src={result.metadata.logoURI} alt={result.metadata.name} style={{ width: '50px' }} />}
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
