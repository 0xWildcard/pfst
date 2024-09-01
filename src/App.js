import React, { useEffect, useState } from 'react';
import axios from 'axios';

const ALCHEMY_API_URL = 'https://solana-mainnet.g.alchemy.com/v2/SjJUD_yrq-FwoP17v2YFizkf2Yryoygu';

function App() {
    const [loading, setLoading] = useState(true);
    const [targetedTransactions, setTargetedTransactions] = useState([]);
    const [statusMessage, setStatusMessage] = useState('');
    const [lastFetchedSignature, setLastFetchedSignature] = useState(null);

    const MINTER_ADDRESS = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
    const SIGNATURE_FETCH_LIMIT = 50; // Fetch 50 signatures at a time
    const POLLING_INTERVAL_MS = 30000; // Poll every 30 seconds

    const TARGET_DATA_BASE64 = [
        '3mimF1vf45io',
        '3ipZWcvdfi4ZMA2h6UPodC5qTfD9CpLKxRF23SBNGvo9LygWEGQyStb2TpFf'
    ];

    const fetchSignatures = async () => {
        try {
            const response = await axios.post(ALCHEMY_API_URL, {
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignaturesForAddress',
                params: [
                    MINTER_ADDRESS,
                    { limit: SIGNATURE_FETCH_LIMIT }
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
    };

    const fetchTransaction = async (transactionId, retryCount = 0) => {
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

                // Extract the token address from account key 19 and liquidity pair address from account key 2
                const tokenAddress = transaction.transaction.message.accountKeys[19];
                const liquidityPairAddress = transaction.transaction.message.accountKeys[2];

                // Fetch token metadata
                const tokenMetadata = await fetchTokenMetadata(tokenAddress);

                return { transaction, tokenAddress, liquidityPairAddress, tokenMetadata };
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
    };

    const parseMetadata = (decodedData) => {
        try {
            // Assuming the decoded data is JSON encoded
            const jsonString = decodedData.toString('utf-8');
            const metadata = JSON.parse(jsonString);

            return {
                name: metadata.name || 'Unknown',
                symbol: metadata.symbol || 'Unknown',
                uri: metadata.uri || 'Unknown',
            };
        } catch (error) {
            console.error('Error parsing metadata:', error);
            return {
                name: 'Unknown',
                symbol: 'Unknown',
                uri: 'Unknown',
            };
        }
    };

    const fetchTokenMetadata = async (tokenAddress) => {
        try {
            // Fetch account info to retrieve the metadata
            const accountInfoResponse = await axios.post(ALCHEMY_API_URL, {
                jsonrpc: '2.0',
                id: 1,
                method: 'getAccountInfo',
                params: [
                    tokenAddress,
                    { encoding: 'base64' }
                ]
            });

            const accountDataBase64 = accountInfoResponse.data.result?.value?.data[0];
            if (!accountDataBase64) {
                return { name: 'Unknown', symbol: 'Unknown', uri: 'Unknown' };
            }

            // Decode the base64 data
            const decodedData = Buffer.from(accountDataBase64, 'base64');

            // Parse the metadata
            return parseMetadata(decodedData);
        } catch (error) {
            console.error('Error fetching token metadata:', error);
            return { name: 'Unknown', symbol: 'Unknown', uri: 'Unknown' };
        }
    };

    const isTargetedTransaction = (transaction) => {
        if (!transaction || !transaction.transaction || !transaction.transaction.message) return false;

        const instructions = transaction.transaction.message.instructions;

        const matchesTargetData = instructions.some(instruction => 
            TARGET_DATA_BASE64.some(target => instruction.data.startsWith(target))
        );

        const matchingAccountStructure = transaction.meta && transaction.meta.postBalances && transaction.meta.postBalances.length === 23;

        const significantBalanceChange = transaction.meta && transaction.meta.postBalances && transaction.meta.postBalances[0] > 1600000000000;

        return matchesTargetData && matchingAccountStructure && significantBalanceChange;
    };

    const pollTransactions = async () => {
        const signatures = await fetchSignatures();

        if (!signatures.length) return;

        const newTransactions = [];

        for (const signature of signatures) {
            if (signature === lastFetchedSignature) break;

            const result = await fetchTransaction(signature);

            if (result && isTargetedTransaction(result.transaction)) {
                console.log(`Transaction ${result.transaction.transaction.signatures[0]} matches the criteria`);
                console.log(`Token Address: ${result.tokenAddress}`);
                console.log(`Liquidity Pair Address: ${result.liquidityPairAddress}`);
                console.log(`Token Metadata: ${JSON.stringify(result.tokenMetadata)}`);

                newTransactions.push(result);
            }
        }

        if (newTransactions.length > 0) {
            setTargetedTransactions([...newTransactions, ...targetedTransactions]);
            setLastFetchedSignature(newTransactions[0].transaction.transaction.signatures[0]);
            setLoading(false);
        }
    };

    useEffect(() => {
        pollTransactions();
        const intervalId = setInterval(pollTransactions, POLLING_INTERVAL_MS);
        return () => clearInterval(intervalId);
    }, [lastFetchedSignature]);

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
                                <div key={index} style={{ marginBottom: '20px' }}>
                                    <strong>Block Time:</strong> {result.transaction.blockTime ? new Date(result.transaction.blockTime * 1000).toLocaleString() : 'N/A'}<br />
                                    <strong>Transaction ID:</strong> {result.transaction.transaction.signatures[0]}<br />
                                    <strong>Token Address:</strong> <a href={`https://pump.fun/${result.tokenAddress}`} target="_blank" rel="noopener noreferrer">{result.tokenAddress}</a><br />
                                    <strong>Liquidity Pair Address:</strong> <a href={`https://dexscreener.com/solana/${result.liquidityPairAddress}`} target="_blank" rel="noopener noreferrer">{result.liquidityPairAddress}</a><br />
                                    <strong>Token Name:</strong> {result.tokenMetadata.name}<br />
                                    <strong>Token Symbol:</strong> {result.tokenMetadata.symbol}<br />
                                    <strong>Token Metadata URI:</strong> <a href={result.tokenMetadata.uri} target="_blank" rel="noopener noreferrer">{result.tokenMetadata.uri}</a><br />
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

