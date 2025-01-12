import express from 'express';
import { PrismaClient } from '@prisma/client';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import cors from 'cors';
import http from 'http';

dotenv.config();

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize WebSocket server for frontend connections
const wss = new WebSocketServer({ server });

// Initialize Prisma client
const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});

// Finnhub WebSocket configuration
const FINNHUB_WS_URL = process.env.URL;
const API_KEY = process.env.API_KEY;
let finnhubSocket = null;

// Data storage
const clients = new Set();
const liveStockData = new Map();
const subscribedStocks = new Set();

// Middleware
app.use(express.json());
app.use(cors());

// Initialize Finnhub WebSocket connection
function initializeFinnhubSocket() {
  finnhubSocket = new WebSocket(`${FINNHUB_WS_URL}?token=${API_KEY}`);

  finnhubSocket.on('open', () => {
    console.log('Connected to Finnhub WebSocket');
    // Resubscribe to all stocks
    subscribedStocks.forEach((symbol) => {
      const subscriptionMessage = JSON.stringify({ type: 'subscribe', symbol });
      finnhubSocket.send(subscriptionMessage);
    });
  });

  finnhubSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      if (message.type === 'trade' && message.data) {
        message.data.forEach((trade) => {
          const { s: symbol, p: price } = trade;
          liveStockData.set(symbol, price);

          // Broadcast updates to all connected clients
          broadcastStockUpdate(symbol, price);
        });
      }
    } catch (error) {
      console.error('Error parsing Finnhub message:', error);
    }
  });

  finnhubSocket.on('error', (error) => {
    console.error('Finnhub WebSocket error:', error);
  });

  finnhubSocket.on('close', () => {
    console.log('Finnhub WebSocket closed, attempting reconnection...');
    setTimeout(initializeFinnhubSocket, 5000);
  });
}

// Initialize the Finnhub connection
initializeFinnhubSocket();

// WebSocket server connection handler
wss.on('connection', async (ws) => {
  console.log('New frontend client connected');
  clients.add(ws);

  // Send initial stock data to the new client
  try {
    const stocks = await prisma.stock.findMany();
    const stocksWithLiveData = stocks.map((stock) => ({
      ...stock,
      livePrice: liveStockData.get(stock.ticker) || null,
    }));
    ws.send(JSON.stringify({ type: 'initial', data: stocksWithLiveData }));
  } catch (error) {
    console.error('Error fetching initial stock data:', error);
  }

  // Handle client disconnection
  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });

  // Handle messages from client
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.action) {
        case 'subscribe':
          await handleSubscription(data.symbol);
          break;
        case 'unsubscribe':
          await handleUnsubscription(data.symbol);
          break;
        // Add more cases as needed
      }
    } catch (error) {
      console.error('Error handling client message:', error);
    }
  });
});

// Broadcast stock updates to all connected clients
function broadcastStockUpdate(symbol, price) {
  const update = JSON.stringify({
    type: 'update',
    data: { symbol, price },
  });

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(update);
    }
  });
}

// Handle stock subscription
async function handleSubscription(symbol) {
  if (!subscribedStocks.has(symbol)) {
    subscribedStocks.add(symbol);
    if (finnhubSocket?.readyState === WebSocket.OPEN) {
      finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol }));
    }
  }
}

// Handle stock unsubscription
async function handleUnsubscription(symbol) {
  if (subscribedStocks.has(symbol)) {
    subscribedStocks.delete(symbol);
    if (finnhubSocket?.readyState === WebSocket.OPEN) {
      finnhubSocket.send(JSON.stringify({ type: 'unsubscribe', symbol }));
    }
  }
}

app.get('/favicon.ico', (req, res) => res.status(204));

app.get('/',(req,res)=>{
  res.send("Backend is up!");
})

// REST API endpoints
app.get('/stocks', async (req, res) => {
  try {
    let stocks = await prisma.stock.findMany();

    if (stocks.length < 5) {
      const initialStocks = [
        'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT',
        'BINANCE:BNBUSDT', 'BINANCE:ADAUSDT',
        'BINANCE:SOLUSDT'
      ];

      await Promise.all(initialStocks.slice(stocks.length).map(async (symbol) => {
        const livePrice = liveStockData.get(symbol);
        if (livePrice) {
          await prisma.stock.create({
            data: {
              ticker: symbol,
              name: symbol,
              quantity: 1,
              buyPrice: livePrice,
            },
          });
          // Subscribe to the new stock
          await handleSubscription(symbol);
        }
      }));

      stocks = await prisma.stock.findMany();
    }

    const stocksWithLiveData = stocks.map(stock => ({
      ...stock,
      livePrice: liveStockData.get(stock.ticker) || null
    }));

    res.json(stocksWithLiveData);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching stocks', error });
  }
});

// Buy stock endpoint
app.post('/stocks/buy', async (req, res) => {
  const { ticker, quantityToBuy } = req.body;

  if (!ticker || !quantityToBuy || quantityToBuy <= 0) {
    return res.status(400).json({ message: 'Invalid request' });
  }

  try {
    const stock = await prisma.stock.findUnique({ where: { ticker } });

    if (!stock) {
      return res.status(404).json({ message: 'Stock not found' });
    }

    const updatedStock = await prisma.stock.update({
      where: { ticker },
      data: { quantity: stock.quantity + quantityToBuy },
    });

    // Ensure we're subscribed to this stock
    await handleSubscription(ticker);

    res.json({
      message: `Bought ${quantityToBuy} shares of ${ticker}`,
      stock: updatedStock,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error buying stock', error });
  }
});

// Sell stock endpoint
app.post('/stocks/sell', async (req, res) => {
  const { ticker, quantityToSell } = req.body;

  if (!ticker || !quantityToSell || quantityToSell <= 0) {
    return res.status(400).json({ message: 'Invalid request' });
  }

  try {
    const stock = await prisma.stock.findUnique({ where: { ticker } });

    if (!stock) {
      return res.status(404).json({ message: 'Stock not found' });
    }

    if (stock.quantity < quantityToSell) {
      return res.status(400).json({ message: 'Insufficient shares' });
    }

    const updatedStock = await prisma.stock.update({
      where: { ticker },
      data: { quantity: stock.quantity - quantityToSell },
    });

    // If no shares left, unsubscribe from updates
    if (updatedStock.quantity === 0) {
      await handleUnsubscription(ticker);
    }

    res.json({
      message: `Sold ${quantityToSell} shares of ${ticker}`,
      stock: updatedStock,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error selling stock', error });
  }
});



// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
