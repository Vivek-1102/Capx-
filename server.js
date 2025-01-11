import express from 'express';
import { PrismaClient } from '@prisma/client';
import WebSocket from 'ws';
import dotenv from "dotenv";
import cors from "cors";
dotenv.config();


const app = express();
const PORT = process.env.PORT || 3000;
const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});

const FINNHUB_WS_URL = process.env.URL;;
const API_KEY = process.env.API_KEY; 
let socket = new WebSocket(`${FINNHUB_WS_URL}?token=${API_KEY}`);


app.use(express.json());
app.use(cors());

const subscriptions = new Map();
const liveStockData = new Map();

socket.on('open', () => {
  console.log('WebSocket connected');
  const initialStocks = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:BNBUSDT', 'BINANCE:ADAUSDT', 'BINANCE:SOLUSDT'];
  initialStocks.forEach((ticker) => {
    const subscriptionMessage = JSON.stringify({ type: 'subscribe', symbol: ticker });
    console.log('Sending:', subscriptionMessage);
    socket.send(subscriptionMessage);
  });
});

socket.on('message', (data) => {

  try {
    const message = JSON.parse(data);

    if (message.type === 'trade' && message.data) {
      message.data.forEach((trade) => {
        const { s: symbol, p: price } = trade;  
        liveStockData.set(symbol, price); 
      });
    }
  } catch (error) {
    console.error('Error parsing WebSocket message:', error);
  }
});



socket.on('error', (err) => {
  console.error('WebSocket Error:', err);
});

socket.on('close', () => {
  console.log('WebSocket connection closed, attempting reconnection...');
  setTimeout(() => {
    socket = new WebSocket(`${FINNHUB_WS_URL}?token=${API_KEY}`);
  }, 5000);
});

app.get('/', (req, res) => {
  res.send('Hello from the backend!');
});


app.get('/stocks', async (req, res) => {
  let stocks = await prisma.stock.findMany();
  console.log('Existing stocks:', stocks);

  const initialStocks = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:BNBUSDT', 'BINANCE:ADAUSDT', 'BINANCE:SOLUSDT'];

  if (stocks.length < 5) {
    const randomStocks = initialStocks.slice(stocks.length, 5);

    for (const stock of randomStocks) {
      const livePrice = liveStockData.get(stock);
      console.log('LiveStockData Map:', liveStockData);


      if (!livePrice) {
        console.error(`No live price available for stock: ${stock}. Skipping...`);
        continue; // Skip if live price is not available
      }

      try {
        // Create stock entry in the database
        await prisma.stock.create({
          data: {
            ticker: stock,
            name: stock,
            quantity: 1, 
            buyPrice: livePrice, 
          },
        });
      } catch (error) {
        console.error(`Error creating stock for ticker ${stock}:`, error);
      }
    }

    // Refetch the stocks after inserting new ones
    stocks = await prisma.stock.findMany();
  }

  // Add live price data to the response
  const stocksWithLiveData = stocks.map((stock) => {
    const liveData = liveStockData.get(stock.ticker);
    return {
      ...stock,
      liveData: liveData ? liveData : null, // Include live price if available
    };
  });

  res.json(stocksWithLiveData);
});


// API Endpoint to subscribe a client to a stock symbol
app.post('/stocks/subscribe', async (req, res) => {
  const { symbol } = req.body;

  if (!symbol) {
    return res.status(400).json({ message: 'Stock symbol is required' });
  }

  try {
    // Ensure the stock exists in the database
    const stock = await prisma.stock.findUnique({
      where: { ticker: symbol },
    });

    if (!stock) {
      return res.status(404).json({ message: `Stock with ticker ${symbol} not found` });
    }

    // If the stock is not already subscribed to, subscribe via WebSocket
    if (!subscriptions.has(symbol)) {
      subscriptions.set(symbol, new Set());
      const subscribeMessage = { type: 'subscribe', symbol };
      socket.send(JSON.stringify(subscribeMessage));
    }
    subscriptions.get(symbol)?.add(res);

    res.status(200).json({ message: `Subscribed to ${symbol} for live updates` });
  } catch (error) {
    res.status(500).json({ message: 'Error subscribing to stock symbol', error });
  }
});

// API Endpoint to unsubscribe a client from a stock symbol
app.post('/stocks/unsubscribe', async (req, res) => {
  const { symbol } = req.body;

  if (!symbol) {
    return res.status(400).json({ message: 'Stock symbol is required' });
  }

  try {
    // Remove the client from the list of subscriptions
    if (subscriptions.has(symbol)) {
      subscriptions.get(symbol)?.delete(res);
      if (subscriptions.get(symbol)?.size === 0) {
        const unsubscribeMessage = { type: 'unsubscribe', symbol };
        socket.send(JSON.stringify(unsubscribeMessage));
        subscriptions.delete(symbol);
      }
    }

    res.status(200).json({ message: `Unsubscribed from ${symbol}` });
  } catch (error) {
    res.status(500).json({ message: 'Error unsubscribing from stock symbol', error });
  }
});

// API Endpoint to add a new stock
app.post('/stocks', async (req, res) => {
  const { ticker, name, quantity, buyPrice } = req.body;

  if (!ticker || !name || !quantity || !buyPrice) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const newStock = await prisma.stock.create({
      data: {
        ticker,
        name,
        quantity,
        buyPrice,
      },
    });
    res.status(201).json(newStock);
  } catch (error) {
    res.status(500).json({ message: 'Error adding stock', error });
  }
});

// API Endpoint to delete a stock by its ticker
app.delete('/stocks/sell', async (req, res) => {
  const { ticker, quantityToSell } = req.body;

  if (!ticker || !quantityToSell || quantityToSell <= 0) {
    return res.status(400).json({ message: 'Invalid request. Provide ticker and valid quantity.' });
  }

  try {
    const stock = await prisma.stock.findUnique({
      where: { ticker },
    });

    if (!stock) {
      return res.status(404).json({ message: `Stock with ticker ${ticker} not found` });
    }

    // Check if the user is selling more stock than they have
    if (stock.quantity < quantityToSell) {
      return res.status(400).json({ message: `Not enough stock available to sell. Current quantity: ${stock.quantity}` });
    }

    const updatedStock = await prisma.stock.update({
      where: { ticker },
      data: {
        quantity: stock.quantity - quantityToSell,
      },
    });

    // If quantity is zero, unsubscribe from receiving updates for that stock
    if (updatedStock.quantity === 0 && subscriptions.has(ticker)) {
      const unsubscribeMessage = { type: 'unsubscribe', symbol: ticker };
      socket.send(JSON.stringify(unsubscribeMessage));
      subscriptions.delete(ticker);
    }

    res.json({
      message: `Successfully sold ${quantityToSell} shares of ${ticker}`,
      updatedStock,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error selling stock', error });
  }
});

// API Endpoint to buy a stock (update quantity)
app.post('/stocks/buy', async (req, res) => {
  const { ticker, quantityToBuy } = req.body;

  if (!ticker || !quantityToBuy || quantityToBuy <= 0) {
    return res.status(400).json({ message: 'Invalid request. Provide ticker and valid quantity.' });
  }

  try {
    const stock = await prisma.stock.findUnique({
      where: { ticker },
    });

    if (!stock) {
      return res.status(404).json({ message: `Stock with ticker ${ticker} not found` });
    }

    const updatedStock = await prisma.stock.update({
      where: { ticker },
      data: {
        quantity: stock.quantity + quantityToBuy,
      },
    });

    res.json({ message: `Successfully bought ${quantityToBuy} shares of ${ticker}`, updatedStock });
  } catch (error) {
    res.status(500).json({ message: 'Error buying stock', error });
  }
});

app.get('/favicon.ico', (req, res) => res.status(204));


// Start Express Server
app.listen(PORT, function(){
  console.log("Express server listening on port %d in %s mode", this.address().port, app.settings.env);
});
