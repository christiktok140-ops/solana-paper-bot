require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

const ADMIN_ID = '8490406962';  // Changed to string for proper comparison
const PAYMENT_WALLET = '9JnEAYUSqp2aTuL2DXmYUko3mYEY5oXj8YCGke5MLHN7';
const MONTHLY_PRICE_USD = 30;
const TRIAL_DAYS = 0;

let db, portfoliosCollection, usersCollection, vipCollection;

async function connectDB() {
    if (!MONGODB_URI) { console.error('MONGODB_URI not defined'); return; }
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('supryme_trading');
    portfoliosCollection = db.collection('portfolios');
    usersCollection = db.collection('users');
    vipCollection = db.collection('vip');
    console.log('✅ MongoDB connected!');
}

async function saveUser(userId, portfolio) {
    try {
        const holdingsObj = {};
        for (const [mint, holding] of portfolio.holdings.entries()) holdingsObj[mint] = holding;
        await portfoliosCollection.updateOne({ userId: String(userId) }, { $set: { virtualUsd: portfolio.virtualUsd, holdings: holdingsObj, trades: portfolio.trades.slice(0, 500), updatedAt: new Date() } }, { upsert: true });
    } catch (e) { console.log(e.message); }
}

async function loadUser(userId) {
    try {
        const doc = await portfoliosCollection.findOne({ userId: String(userId) });
        if (!doc) return null;
        const holdingsMap = new Map();
        if (doc.holdings) for (const [mint, holding] of Object.entries(doc.holdings)) holdingsMap.set(mint, holding);
        return { virtualUsd: doc.virtualUsd ?? 1000.0, holdings: holdingsMap, trades: doc.trades || [] };
    } catch (e) { return null; }
}

async function getUserAccess(userId) { try { return await usersCollection.findOne({ userId: String(userId) }); } catch (e) { return null; } }
async function isVip(userId) { try { return !!(await vipCollection.findOne({ userId: String(userId) })); } catch (e) { return false; } }

async function hasAccess(userId) {
    const userIdStr = String(userId);
    if (userIdStr === ADMIN_ID) return true;
    if (await isVip(userIdStr)) return true;
    const user = await getUserAccess(userIdStr);
    if (!user) return false;
    if (user.subscribedUntil && new Date(user.subscribedUntil) > new Date()) return true;
    return false;
}

async function startTrial(userId) {
    try {
        const userIdStr = String(userId);
        const existing = await usersCollection.findOne({ userId: userIdStr });
        if (existing) return existing;
        await usersCollection.insertOne({ userId: userIdStr, trialStarted: new Date(), subscribedUntil: null, createdAt: new Date() });
        return await usersCollection.findOne({ userId: userIdStr });
    } catch (e) { console.log(e.message); }
}

async function activateSubscription(userId, months = 1) {
    try {
        const userIdStr = String(userId);
        const user = await usersCollection.findOne({ userId: userIdStr });
        const now = new Date();
        let startFrom = now;
        if (user?.subscribedUntil && new Date(user.subscribedUntil) > now) startFrom = new Date(user.subscribedUntil);
        const newExpiry = new Date(startFrom);
        newExpiry.setMonth(newExpiry.getMonth() + months);
        await usersCollection.updateOne({ userId: userIdStr }, { $set: { subscribedUntil: newExpiry, updatedAt: now } }, { upsert: true });
        return newExpiry;
    } catch (e) { console.log(e.message); }
}

async function getSolPrice() {
    try {
        const res = await axios.get('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', { timeout: 5000 });
        const pair = res.data.pairs?.[0];
        return pair ? parseFloat(pair.priceUsd) : 150;
    } catch { return 150; }
}

async function getRequiredSol() { const solPrice = await getSolPrice(); return MONTHLY_PRICE_USD / solPrice; }

const userPortfolios = new Map();
const priceCache = new Map();
const CACHE_TTL = 5000;

async function getTokenData(mintAddress) {
    if (priceCache.has(mintAddress)) {
        const cached = priceCache.get(mintAddress);
        if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
    }
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 8000 });
        const pair = response.data.pairs?.[0];
        if (!pair) return null;
        const tokenData = {
            name: pair.baseToken?.name || 'Unknown',
            symbol: pair.baseToken?.symbol || '???',
            mintAddress: pair.baseToken?.address || mintAddress,
            priceUsd: parseFloat(pair.priceUsd) || 0,
            marketCap: pair.fdv || pair.marketCap || 0,
            liquidity: pair.liquidity?.usd || 0,
            volume24h: pair.volume?.h24 || 0,
            priceChange24h: pair.priceChange?.h24 || 0,
            exchange: pair.dexId || 'DexScreener',
            pooledUsdc: pair.liquidity?.quote || 0,
            imageUrl: pair.info?.imageUrl || null,
        };
        priceCache.set(mintAddress, { data: tokenData, timestamp: Date.now() });
        return tokenData;
    } catch (error) { return null; }
}

async function initializeUser(userId) {
    const userIdStr = String(userId);
    if (!userPortfolios.has(userIdStr)) {
        const saved = await loadUser(userIdStr);
        userPortfolios.set(userIdStr, {
            virtualUsd: saved?.virtualUsd ?? 1000.0,
            holdings: saved?.holdings ?? new Map(),
            trades: saved?.trades ?? [],
            cards: new Map(),
            currentMint: null,
            pendingAction: null,
            currentTokenData: null,
            lastMessageId: null,
            lastMessageHasPhoto: false,
            pendingMessageId: null,
        });
    }
    return userPortfolios.get(userIdStr);
}

function shortCA(addr) { return `${addr.slice(0, 8)}...${addr.slice(-4)}`; }

function formatUsd(num) {
    if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
    return `$${num.toFixed(2)}`;
}

function formatTokenMessage(tokenData, portfolio) {
    const changeEmoji = tokenData.priceChange24h >= 0 ? '🟢' : '🔴';
    const changeSign = tokenData.priceChange24h >= 0 ? '+' : '';
    const divider = `─────────────────`;
    const lastUpdated = new Date().toLocaleTimeString();
    return (
        `🔍 [Search on X](https://twitter.com/search?q=%24${tokenData.symbol})\n` +
        `⚡ *${tokenData.exchange.toUpperCase()}*  •  *${tokenData.name}* (\\$${tokenData.symbol})\n` +
        `${changeEmoji} *${changeSign}${tokenData.priceChange24h.toFixed(2)}%*\n\n` +
        `${divider}\n` +
        `📊 *MARKET INFO*\n` +
        `${divider}\n` +
        `💰 Market Cap:  *${formatUsd(tokenData.marketCap)}*\n` +
        `💧 Liquidity:   *${formatUsd(tokenData.liquidity)}*\n` +
        `🧃 Pooled USDC: *${formatUsd(tokenData.pooledUsdc)}*\n` +
        `📈 24h Volume:  *${formatUsd(tokenData.volume24h)}*\n\n` +
        `${divider}\n` +
        `👛 *YOUR WALLET*\n` +
        `${divider}\n` +
        `💵 Balance:  *$${portfolio.virtualUsd.toFixed(2)}*\n\n` +
        `🕐 _Updated: ${lastUpdated}_`
    );
}

function formatHoldingMessage(tokenData, holding, portfolio) {
    const currentValueUsd = holding.amount * tokenData.priceUsd;
    const initialValueUsd = holding.amountUsd;
    const pnlUsd = currentValueUsd - initialValueUsd;
    const pnlPercent = (pnlUsd / initialValueUsd) * 100;
    const pnlEmoji = pnlUsd >= 0 ? '🟢' : '🔴';
    const pnlSign = pnlUsd >= 0 ? '+' : '';
    const divider = `─────────────────`;
    const lastUpdated = new Date().toLocaleTimeString();
    const entryMcap = holding.marketCapAtBuy ? formatUsd(holding.marketCapAtBuy) : 'N/A';
    return (
        `🔍 [Search on X](https://twitter.com/search?q=%24${tokenData.symbol})\n` +
        `⚡ *${tokenData.exchange.toUpperCase()}*  •  *${tokenData.name}* (\\$${tokenData.symbol})\n` +
        `${pnlEmoji} *${pnlSign}${pnlPercent.toFixed(2)}%*\n\n` +
        `${divider}\n` +
        `📈 *YOUR POSITION*\n` +
        `${divider}\n` +
        `💰 Invested:   *$${initialValueUsd.toFixed(2)}*\n` +
        `💎 Now Worth:  *$${currentValueUsd.toFixed(2)}*\n` +
        `${pnlEmoji} PnL:  *${pnlSign}$${pnlUsd.toFixed(2)}* *(${pnlSign}${pnlPercent.toFixed(2)}%)*\n` +
        `📊 Entry MCap: *${entryMcap}*\n\n` +
        `${divider}\n` +
        `📊 *MARKET INFO*\n` +
        `${divider}\n` +
        `💧 Liquidity:   *${formatUsd(tokenData.liquidity)}*\n` +
        `💡 Current MCap: *${formatUsd(tokenData.marketCap)}*\n` +
        `💵 Price:       *$${tokenData.priceUsd.toFixed(8)}*\n\n` +
        `${divider}\n` +
        `🏦 *YOUR WALLET*\n` +
        `${divider}\n` +
        `💵 Balance:   *$${portfolio.virtualUsd.toFixed(2)}*\n` +
        `📊 Holdings:  *${holding.amount.toFixed(2)} ${tokenData.symbol}*\n\n` +
        `🕐 _Updated: ${lastUpdated}_`
    );
}

function getTokenButtons(hasHolding) {
    const rows = [
        [
            Markup.button.callback('🔄 Refresh', 'refresh'),
            Markup.button.callback('🗑 Delete', 'delete_card'),
            Markup.button.callback('👤 Profile', 'profile'),
        ],
        [
            Markup.button.callback('💚 Buy $10', 'buy_10'),
            Markup.button.callback('💚 Buy $25', 'buy_25'),
            Markup.button.callback('💚 Buy $50', 'buy_50'),
        ],
        [
            Markup.button.callback('💚 Buy $100', 'buy_100'),
            Markup.button.callback('💚 Buy $200', 'buy_200'),
            Markup.button.callback('💚 Buy $X', 'buy_x'),
        ],
        [
            Markup.button.callback(hasHolding ? '🔴 Sell ✅' : '⛔ Sell ❌', 'paper_sell'),
        ],
    ];
    return Markup.inlineKeyboard(rows);
}

async function paperBuy(userId, mint, tokenData, amountUsd) {
    const userIdStr = String(userId);
    const portfolio = userPortfolios.get(userIdStr);
    if (!portfolio) return { success: false, error: 'No portfolio found' };
    if (portfolio.virtualUsd < amountUsd) return { success: false, error: `You only have $${portfolio.virtualUsd.toFixed(2)}` };
    const buyFee = amountUsd * 0.01;
    const totalCost = amountUsd + buyFee;
    if (portfolio.virtualUsd < totalCost) return { success: false, error: `Need $${totalCost.toFixed(2)} inc. 1% fee` };
    const tokenAmount = amountUsd / tokenData.priceUsd;
    const currentHolding = portfolio.holdings.get(mint) || { amount: 0, avgPrice: 0, amountUsd: 0, marketCapAtBuy: 0 };
    const totalTokens = currentHolding.amount + tokenAmount;
    const totalCostUsd = (currentHolding.amount * currentHolding.avgPrice) + amountUsd;
    const newAvgPrice = totalCostUsd / totalTokens;
    const totalMcapAtBuy = (currentHolding.amountUsd * (currentHolding.marketCapAtBuy || 0)) + (amountUsd * tokenData.marketCap);
    const newAvgMcapAtBuy = totalMcapAtBuy / totalCostUsd;
    portfolio.virtualUsd -= totalCost;
    portfolio.holdings.set(mint, { amount: totalTokens, avgPrice: newAvgPrice, amountUsd: (currentHolding.amountUsd || 0) + amountUsd, marketCapAtBuy: newAvgMcapAtBuy });
    portfolio.trades.unshift({ type: 'BUY', token: tokenData.symbol, amountUsd, fee: buyFee, tokenAmount, price: tokenData.priceUsd, marketCapAtBuy: tokenData.marketCap, time: new Date().toLocaleTimeString() });
    await saveUser(userIdStr, portfolio);
    return { success: true, tokenAmount, costUsd: totalCost, fee: buyFee, remainingUsd: portfolio.virtualUsd, marketCapAtBuy: tokenData.marketCap };
}

async function paperSell(userId, mint, tokenData, percentToSell) {
    const userIdStr = String(userId);
    const portfolio = userPortfolios.get(userIdStr);
    if (!portfolio) return { success: false, error: 'No portfolio found' };
    const holding = portfolio.holdings.get(mint);
    if (!holding || holding.amount === 0) return { success: false, error: "You don't hold this token" };
    const tokenAmount = holding.amount * (percentToSell / 100);
    const grossRevenueUsd = tokenAmount * tokenData.priceUsd;
    const sellFee = grossRevenueUsd * 0.01;
    const revenueUsd = grossRevenueUsd - sellFee;
    const costBasisUsd = holding.avgPrice * tokenAmount;
    const profitUsd = revenueUsd - costBasisUsd;
    const profitPercent = (profitUsd / costBasisUsd) * 100;
    portfolio.virtualUsd += revenueUsd;
    const remainingAmount = holding.amount - tokenAmount;
    if (remainingAmount < 0.01) { portfolio.holdings.delete(mint); }
    else { portfolio.holdings.set(mint, { amount: remainingAmount, avgPrice: holding.avgPrice, amountUsd: holding.amountUsd * (1 - percentToSell / 100), marketCapAtBuy: holding.marketCapAtBuy }); }
    portfolio.trades.unshift({ type: 'SELL', token: tokenData.symbol, amountUsd: revenueUsd, fee: sellFee, tokenAmount, price: tokenData.priceUsd, profitUsd, profitPercent, marketCapAtBuy: holding.marketCapAtBuy, marketCapAtSell: tokenData.marketCap, investedAmount: (tokenAmount / (percentToSell / 100)) * holding.avgPrice, time: new Date().toLocaleTimeString() });
    await saveUser(userIdStr, portfolio);
    return { success: true, revenueUsd, fee: sellFee, profitUsd, profitPercent, remainingUsd: portfolio.virtualUsd, entryMcap: holding.marketCapAtBuy, exitMcap: tokenData.marketCap, investedAmount: (tokenAmount / (percentToSell / 100)) * holding.avgPrice };
}

async function updateTokenCard(ctx, tokenData, portfolio) {
    const messageId = ctx.callbackQuery?.message?.message_id;
    const card = portfolio.cards.get(messageId);
    const mint = tokenData.mintAddress;
    const holding = portfolio.holdings.get(mint);
    const buttons = getTokenButtons(!!holding);
    const message = holding ? formatHoldingMessage(tokenData, holding, portfolio) : formatTokenMessage(tokenData, portfolio);
    if (messageId) {
        try {
            if (card?.hasPhoto) { await ctx.telegram.editMessageCaption(ctx.chat.id, messageId, null, message, { parse_mode: 'Markdown', reply_markup: buttons.reply_markup }); }
            else { await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, message, { parse_mode: 'Markdown', reply_markup: buttons.reply_markup }); }
            portfolio.cards.set(messageId, { mint, tokenData, hasPhoto: card?.hasPhoto || false });
            return;
        } catch (e) { if (e.message?.includes('message is not modified')) return; }
    }
    await sendTokenCard(ctx, tokenData, portfolio);
}

async function sendTokenCard(ctx, tokenData, portfolio) {
    const mint = tokenData.mintAddress;
    const holding = portfolio.holdings.get(mint);
    const buttons = getTokenButtons(!!holding);
    const message = holding ? formatHoldingMessage(tokenData, holding, portfolio) : formatTokenMessage(tokenData, portfolio);
    let sent, hasPhoto = false;
    if (tokenData.imageUrl) { sent = await ctx.replyWithPhoto(tokenData.imageUrl, { caption: message, parse_mode: 'Markdown', reply_markup: buttons.reply_markup }); hasPhoto = true; }
    else { sent = await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: buttons.reply_markup }); }
    portfolio.cards.set(sent.message_id, { mint, tokenData, hasPhoto });
    portfolio.lastMessageId = sent.message_id;
    portfolio.lastMessageHasPhoto = hasPhoto;
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

async function checkAccess(ctx, next) {
    const userId = ctx.from?.id;
    if (!userId) return;
    const userIdStr = String(userId);
    if (userIdStr === ADMIN_ID) return next();
    const text = ctx.message?.text || '';
    if (text === '/start' || text === '/pay') return next();
    if (await hasAccess(userIdStr)) return next();
    const solRequired = await getRequiredSol();
    await ctx.reply(
        `🔒 *Access Required*\n` +
        `─────────────────\n\n` +
        `Subscribe for *$${MONTHLY_PRICE_USD}/month*\n` +
        `💰 Pay: *${solRequired.toFixed(4)} SOL*\n\n` +
        `─────────────────\n` +
        `📤 *Send SOL to:*\n` +
        `\`${PAYMENT_WALLET}\`\n\n` +
        `─────────────────\n` +
        `⚠️ *After sending SOL:*\n` +
        `Contact @Supryme_loves_memecoins with transaction proof\n\n` +
        `─────────────────`,
        { parse_mode: 'Markdown' }
    );
}
bot.use(checkAccess);

bot.start(async (ctx) => {
    const userId = String(ctx.from.id);
    await startTrial(userId);
    await initializeUser(userId);
    const portfolio = userPortfolios.get(userId);
    const user = await getUserAccess(userId);
    const vip = await isVip(userId);
    let accessLine = '';
    if (userId === ADMIN_ID || vip) { accessLine = `✅ *Access: Lifetime Free*\n`; }
    else if (user?.subscribedUntil && new Date(user.subscribedUntil) > new Date()) { accessLine = `✅ *Subscribed until: ${new Date(user.subscribedUntil).toLocaleDateString()}*\n`; }
    else { accessLine = `⚠️ *No active subscription — /pay to subscribe*\n`; }
    const divider = `─────────────────`;
    const name = ctx.from.first_name || 'Trader';
    const caption =
        `💎 *Welcome, ${name}!*\n` +
        `${divider}\n\n` +
        `🚀 *SUPRYME DEMO TRADING*\n\n` +
        `Trade real Solana memecoins with\n` +
        `virtual money. Live blockchain prices,\n` +
        `real tokens — no simulations.\n\n` +
        `${divider}\n\n` +
        `${accessLine}` +
        `${divider}\n\n` +
        `💵 Balance:   *$${portfolio.virtualUsd.toFixed(2)}*\n` +
        `📦 Holdings:  *${portfolio.holdings.size}*\n` +
        `📊 Trades:    *${portfolio.trades.filter(t => t.type === 'SELL').length}*\n\n` +
        `${divider}\n\n` +
        `✨ *Paste any Solana CA to start*\n\n` +
        `${divider}\n` +
        `📜 /history  •  👤 /portfolio  •  💰 /pay\n\n` +
        `⚡ _Created by Supryme_`;
    await ctx.reply(caption, { parse_mode: 'Markdown' });
});

bot.command('pay', async (ctx) => {
    const solRequired = await getRequiredSol();
    const solPrice = await getSolPrice();
    const userId = ctx.from.id;
    await ctx.reply(
        `💳 *Subscribe to Supryme Demo Trading*\n` +
        `─────────────────\n\n` +
        `💵 Price: *$${MONTHLY_PRICE_USD}/month*\n` +
        `💰 Pay: *${solRequired.toFixed(4)} SOL*\n` +
        `📊 SOL Price: *$${solPrice.toFixed(2)}*\n\n` +
        `─────────────────\n` +
        `📤 *Send SOL to:*\n` +
        `\`${PAYMENT_WALLET}\`\n\n` +
        `─────────────────\n` +
        `⚠️ *After sending SOL:*\n` +
        `1️⃣ Take a screenshot of the transaction\n` +
        `2️⃣ Send it to @Supryme_loves_memecoins\n` +
        `3️⃣ Include your Telegram ID: \`${userId}\`\n\n` +
        `─────────────────\n` +
        `💡 *Once verified, you will get access within 24 hours*`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('addvip', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /addvip TELEGRAM_ID');
    const targetId = args[1].trim();
    await vipCollection.updateOne({ userId: targetId }, { $set: { userId: targetId, addedAt: new Date() } }, { upsert: true });
    await ctx.reply(`✅ Added ${targetId} to VIP list`);
});

bot.command('removevip', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /removevip TELEGRAM_ID');
    const targetId = args[1].trim();
    await vipCollection.deleteOne({ userId: targetId });
    await ctx.reply(`✅ Removed ${targetId} from VIP list`);
});

bot.command('listvip', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const vips = await vipCollection.find({}).toArray();
    if (vips.length === 0) return ctx.reply('No VIP users.');
    const list = vips.map((v, i) => `${i + 1}. \`${v.userId}\``).join('\n');
    await ctx.reply(`👑 *VIP Users (${vips.length})*\n\n${list}`, { parse_mode: 'Markdown' });
});

bot.command('grantaccess', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /grantaccess TELEGRAM_ID [months]');
    const targetId = args[1].trim();
    const months = parseInt(args[2]) || 1;
    await usersCollection.updateOne({ userId: targetId }, { $set: { userId: targetId, trialStarted: new Date() } }, { upsert: true });
    const expiry = await activateSubscription(targetId, months);
    await ctx.reply(`✅ Granted ${months} month(s) access to ${targetId}\nExpires: ${expiry.toLocaleDateString()}`);
});

bot.command('users', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const total = await usersCollection.countDocuments();
    const subscribed = await usersCollection.countDocuments({ subscribedUntil: { $gt: new Date() } });
    const trial = total - subscribed;
    await ctx.reply(
        `📊 *Bot Stats*\n\n` +
        `👥 Total Users: *${total}*\n` +
        `✅ Subscribed: *${subscribed}*\n` +
        `⏳ Expired/Trial: *${trial}*`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('test', async (ctx) => {
    await ctx.reply('Testing API connection...');
    try {
        const testAddr = 'So11111111111111111111111111111111111111112';
        const result = await getTokenData(testAddr);
        if (result) { await ctx.reply(`✅ API Working! Price: $${result.priceUsd}`); }
        else { await ctx.reply(`❌ API Failed.`); }
    } catch (error) { await ctx.reply(`❌ Error: ${error.message}`); }
});

bot.command('myid', async (ctx) => {
    await ctx.reply(`Your ID: ${ctx.from.id}\nAdmin ID: ${ADMIN_ID}\nMatch: ${String(ctx.from.id) === ADMIN_ID}`);
});

bot.command('refill', async (ctx) => {
    const userId = String(ctx.from.id);
    userPortfolios.set(userId, { virtualUsd: 1000.0, holdings: new Map(), trades: [], cards: new Map(), currentMint: null, pendingAction: null, currentTokenData: null, lastMessageId: null, lastMessageHasPhoto: false, pendingMessageId: null });
    await saveUser(userId, userPortfolios.get(userId));
    await ctx.reply('✅ Portfolio refilled! You have $1,000.00');
});

async function buildProfileMessage(portfolio) {
    const divider = `─────────────────`;
    let totalPnl = 0, totalSold = 0;
    for (let trade of portfolio.trades) { if (trade.type === 'SELL' && trade.profitUsd !== undefined) { totalPnl += trade.profitUsd; totalSold += trade.amountUsd; } }
    const totalPnlPct = totalSold > 0 ? (totalPnl / totalSold) * 100 : 0;
    const pnlEmoji = totalPnl >= 0 ? '🟢' : '🔴';
    const pnlSign = totalPnl >= 0 ? '+' : '';
    let message = `👤 *PROFILE*\n${divider}\n\n🎯 Balance:      *$${portfolio.virtualUsd.toFixed(2)}*\n${divider}\n\n💰 Initial:      *$1000.00*\n💸 Sold:         *$${totalSold.toFixed(2)}*\n${pnlEmoji} Current PnL:  *${pnlSign}$${totalPnl.toFixed(2)} (${pnlSign}${totalPnlPct.toFixed(2)}%)*\n\n${divider}\n`;
    if (portfolio.holdings.size > 0) { message += `\n📦 *Open Positions (${portfolio.holdings.size})*\n${divider}\n`; for (const [mint, holding] of portfolio.holdings) { message += `• *${shortCA(mint)}* — $${holding.amountUsd.toFixed(2)} invested\n`; } message += `\n`; } else { message += `\n📦 No open positions\n\n`; }
    message += `${divider}\n📜 Trades:  *${portfolio.trades.filter(t => t.type === 'SELL').length}*\n${divider}`;
    return message;
}

bot.command('portfolio', async (ctx) => {
    const userId = String(ctx.from.id);
    await initializeUser(userId);
    const portfolio = userPortfolios.get(userId);
    const message = await buildProfileMessage(portfolio);
    await ctx.reply(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) });
});

bot.command('history', async (ctx) => {
    const userId = String(ctx.from.id);
    await initializeUser(userId);
    const portfolio = userPortfolios.get(userId);
    const sells = portfolio?.trades.filter(t => t.type === 'SELL') || [];
    if (sells.length === 0) return ctx.reply('No completed trades yet.');
    let wins = 0, losses = 0, totalPnl = 0, totalInvested = 0;
    for (const trade of sells) { if (trade.profitUsd > 0) wins++; else if (trade.profitUsd < 0) losses++; totalPnl += trade.profitUsd; totalInvested += trade.amountUsd; }
    const winRate = sells.length > 0 ? (wins / sells.length) * 100 : 0;
    const totalPnlSign = totalPnl >= 0 ? '+' : '';
    const totalPnlEmoji = totalPnl >= 0 ? '🟢' : '🔴';
    const divider = `─────────────────`;
    let message = `📊 *TRADING SUMMARY*\n${divider}\n📜 Total Trades: *${sells.length}*\n✅ Wins: *${wins}*   ❌ Losses: *${losses}*\n📈 Win Rate: *${winRate.toFixed(1)}%*\n${totalPnlEmoji} Total PnL: *${totalPnlSign}$${totalPnl.toFixed(2)}*\n${divider}\n\n📜 *DETAILS*\n${divider}\n\n`;
    sells.forEach((trade, i) => {
        const sign = trade.profitUsd >= 0 ? '+' : '';
        const emoji = trade.profitUsd >= 0 ? '✅' : '❌';
        const num = sells.length - i;
        message += `*#${num}  ${emoji} ${trade.token}*\n`;
        message += `💰 Invested:    *$${trade.amountUsd.toFixed(2)}*\n`;
        if (trade.marketCapAtBuy) message += `📊 Entry MCap:  *$${trade.marketCapAtBuy.toLocaleString()}*\n`;
        if (trade.marketCapAtSell) message += `📊 Exit MCap:   *$${trade.marketCapAtSell.toLocaleString()}*\n`;
        message += `${trade.profitUsd >= 0 ? '🟢' : '🔴'} P&L:         *${sign}$${trade.profitUsd.toFixed(2)} (${sign}${trade.profitPercent.toFixed(2)}%)*\n`;
        message += `💸 Fee:         *$${(trade.fee || 0).toFixed(2)}* _(1%)_\n`;
        message += `⏱️ ${trade.time}\n`;
        message += `${divider}\n`;
    });
    await ctx.reply(message, { parse_mode: 'Markdown' });
});

bot.action('profile', async (ctx) => {
    const userId = String(ctx.from.id);
    const portfolio = userPortfolios.get(userId);
    if (!portfolio) return ctx.answerCbQuery('No portfolio found.');
    await ctx.answerCbQuery();
    const message = await buildProfileMessage(portfolio);
    await ctx.reply(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) });
});

bot.action('close_profile', async (ctx) => { await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) {} });

bot.on('text', async (ctx) => {
    const userId = String(ctx.from.id);
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    await initializeUser(userId);
    const p = userPortfolios.get(userId);
    if (p.pendingAction === 'buy_x') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) { p.pendingAction = null; return ctx.reply('❌ Send a valid number.'); }
        p.pendingAction = null;
        const result = await paperBuy(userId, p.currentMint, p.currentTokenData, amount);
        if (!result.success) return ctx.reply(`❌ ${result.error}`);
        await ctx.reply(
            `✅ *BUY EXECUTED*\n` +
            `─────────────────\n` +
            `💚 Amount:    *$${amount.toFixed(2)}*\n` +
            `📊 Entry MCap: *$${p.currentTokenData.marketCap.toLocaleString()}*\n` +
            `💸 Fee:       *$${result.fee.toFixed(2)}* _(1%)_\n` +
            `🏦 Balance:   *$${result.remainingUsd.toFixed(2)}*\n` +
            `─────────────────\n` +
            `🎮 _Demo Trade by Supryme_`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) }
        );
        await updateTokenCard(ctx, p.currentTokenData, p);
        return;
    }
    if (p.pendingAction === 'sell_x') {
        const percent = parseFloat(text);
        if (isNaN(percent) || percent <= 0 || percent > 100) { p.pendingAction = null; return ctx.reply('❌ Send a number between 1 and 100.'); }
        p.pendingAction = null;
        const result = await paperSell(userId, p.currentMint, p.currentTokenData, percent);
        if (!result.success) return ctx.reply(`❌ ${result.error}`);
        const sign = result.profitUsd >= 0 ? '+' : '';
        await ctx.reply(
            `${result.profitUsd >= 0 ? '🟢' : '🔴'} *SELL EXECUTED*\n` +
            `─────────────────\n` +
            `💰 Invested:   *$${result.investedAmount?.toFixed(2) || 'N/A'}*\n` +
            `📊 Entry MCap: *$${result.entryMcap?.toLocaleString() || 'N/A'}*\n` +
            `📊 Exit MCap:  *$${p.currentTokenData.marketCap.toLocaleString()}*\n` +
            `${result.profitUsd >= 0 ? '🟢' : '🔴'} P&L:       *${sign}$${result.profitUsd.toFixed(2)} (${sign}${result.profitPercent.toFixed(2)}%)*\n` +
            `💸 Fee:        *$${result.fee.toFixed(2)}* _(1%)_\n` +
            `🏦 Balance:    *$${result.remainingUsd.toFixed(2)}*\n` +
            `─────────────────\n` +
            `🎮 _Demo Trade by Supryme_`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) }
        );
        await updateTokenCard(ctx, p.currentTokenData, p);
        return;
    }
    const loading = await ctx.reply(`🔍 Fetching token data...`);
    p.currentMint = text;
    p.lastMessageId = null;
    const tokenData = await getTokenData(text);
    try { await ctx.deleteMessage(loading.message_id); } catch (e) {}
    if (!tokenData) return ctx.reply('❌ Token not found. Try /test to check API connection.');
    p.currentTokenData = tokenData;
    await sendTokenCard(ctx, tokenData, p);
});

for (const amount of [10, 25, 50, 100, 200]) {
    bot.action(`buy_${amount}`, async (ctx) => {
        const userId = String(ctx.from.id);
        const portfolio = userPortfolios.get(userId);
        const messageId = ctx.callbackQuery?.message?.message_id;
        const card = portfolio?.cards.get(messageId);
        if (!card) return ctx.answerCbQuery('Send a contract address first.');
        await ctx.answerCbQuery(`Buying $${amount}...`);
        const result = await paperBuy(userId, card.mint, card.tokenData, amount);
        if (!result.success) return ctx.reply(`❌ ${result.error}`);
        await ctx.reply(
            `✅ *BUY EXECUTED*\n` +
            `─────────────────\n` +
            `💚 Amount:    *$${amount.toFixed(2)}*\n` +
            `📊 Entry MCap: *$${card.tokenData.marketCap.toLocaleString()}*\n` +
            `💸 Fee:       *$${result.fee.toFixed(2)}* _(1%)_\n` +
            `🏦 Balance:   *$${result.remainingUsd.toFixed(2)}*\n` +
            `─────────────────\n` +
            `🎮 _Demo Trade by Supryme_`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) }
        );
        const fresh = await getTokenData(card.mint);
        if (fresh) card.tokenData = fresh;
        await updateTokenCard(ctx, card.tokenData, portfolio);
    });
}

bot.action('buy_x', async (ctx) => {
    const userId = String(ctx.from.id);
    const portfolio = userPortfolios.get(userId);
    const messageId = ctx.callbackQuery?.message?.message_id;
    const card = portfolio?.cards.get(messageId);
    if (!card) return ctx.answerCbQuery('Send a contract address first.');
    await ctx.answerCbQuery();
    portfolio.pendingAction = 'buy_x';
    portfolio.pendingMessageId = messageId;
    portfolio.currentMint = card.mint;
    portfolio.currentTokenData = card.tokenData;
    await ctx.reply('💰 Send the amount in USD you want to buy (e.g. 25):', Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]));
});

bot.action('paper_sell', async (ctx) => {
    const userId = String(ctx.from.id);
    const portfolio = userPortfolios.get(userId);
    const messageId = ctx.callbackQuery?.message?.message_id;
    const card = portfolio?.cards.get(messageId);
    if (!card) return ctx.answerCbQuery('No token selected.');
    const holding = portfolio?.holdings.get(card.mint);
    if (!holding || holding.amount === 0) return ctx.answerCbQuery("❌ You don't hold this token.");
    portfolio.pendingMessageId = messageId;
    portfolio.currentMint = card.mint;
    portfolio.currentTokenData = card.tokenData;
    await ctx.answerCbQuery();
    const sellButtons = Markup.inlineKeyboard([
        [Markup.button.callback('Sell 25%', 'sell_25'), Markup.button.callback('Sell 50%', 'sell_50')],
        [Markup.button.callback('Sell 75%', 'sell_75'), Markup.button.callback('Sell 100%', 'sell_100')],
        [Markup.button.callback('Sell X%', 'sell_x')],
        [Markup.button.callback('❌ Close', 'close_profile')]
    ]);
    await ctx.reply(
        `💸 *Sell ${portfolio.currentTokenData.symbol}*\n` +
        `You have: ${holding.amount.toFixed(2)} tokens\n` +
        `Price: $${portfolio.currentTokenData.priceUsd.toFixed(8)}\n\n` +
        `Choose how much to sell:`,
        { parse_mode: 'Markdown', ...sellButtons }
    );
});

for (const percent of [25, 50, 75, 100]) {
    bot.action(`sell_${percent}`, async (ctx) => {
        const userId = String(ctx.from.id);
        const portfolio = userPortfolios.get(userId);
        const pendingMsgId = portfolio.pendingMessageId;
        const originalMessageId = ctx.callbackQuery.message.message_id;
        await ctx.answerCbQuery();
        let sellTokenData = portfolio.currentTokenData;
        const fresh = await getTokenData(portfolio.currentMint);
        if (fresh) { sellTokenData = fresh; portfolio.currentTokenData = fresh; }
        const result = await paperSell(userId, portfolio.currentMint, sellTokenData, percent);
        if (!result.success) return ctx.reply(`❌ ${result.error}`);
        const sign = result.profitUsd >= 0 ? '+' : '';
        await ctx.reply(
            `${result.profitUsd >= 0 ? '🟢' : '🔴'} *SELL ${percent}% EXECUTED*\n` +
            `─────────────────\n` +
            `💰 Invested:   *$${result.investedAmount?.toFixed(2) || 'N/A'}*\n` +
            `📊 Entry MCap: *$${result.entryMcap?.toLocaleString() || 'N/A'}*\n` +
            `📊 Exit MCap:  *$${sellTokenData.marketCap.toLocaleString()}*\n` +
            `${result.profitUsd >= 0 ? '🟢' : '🔴'} P&L:       *${sign}$${result.profitUsd.toFixed(2)} (${sign}${result.profitPercent.toFixed(2)}%)*\n` +
            `💸 Fee:        *$${result.fee.toFixed(2)}* _(1%)_\n` +
            `🏦 Balance:    *$${result.remainingUsd.toFixed(2)}*\n` +
            `─────────────────\n` +
            `🎮 _Demo Trade by Supryme_`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) }
        );
        const updatedCard = portfolio.cards.get(originalMessageId);
        if (updatedCard) {
            const freshTokenData = await getTokenData(portfolio.currentMint);
            if (freshTokenData) updatedCard.tokenData = freshTokenData;
            await updateTokenCard(ctx, updatedCard.tokenData, portfolio);
        }
    });
}

bot.action('sell_x', async (ctx) => {
    const userId = String(ctx.from.id);
    const portfolio = userPortfolios.get(userId);
    await ctx.answerCbQuery();
    portfolio.pendingAction = 'sell_x';
    await ctx.reply('💸 Send the percentage you want to sell (e.g. 30 for 30%):', Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]));
});

bot.action('delete_card', async (ctx) => {
    const userId = String(ctx.from.id);
    const portfolio = userPortfolios.get(userId);
    const messageId = ctx.callbackQuery?.message?.message_id;
    await ctx.answerCbQuery('Card deleted 🗑');
    try { await ctx.deleteMessage(); } catch (e) {}
    portfolio.cards.delete(messageId);
});

bot.action('refresh', async (ctx) => {
    const userId = String(ctx.from.id);
    const portfolio = userPortfolios.get(userId);
    const messageId = ctx.callbackQuery?.message?.message_id;
    const card = portfolio?.cards.get(messageId);
    if (!card) return ctx.answerCbQuery('No token selected.');
    await ctx.answerCbQuery('🔄 Refreshing...');
    const freshData = await getTokenData(card.mint);
    if (!freshData) return ctx.answerCbQuery('❌ Failed to fetch price');
    card.tokenData = freshData;
    portfolio.cards.set(messageId, card);
    if (portfolio.currentMint === card.mint) portfolio.currentTokenData = freshData;
    await updateTokenCard(ctx, freshData, portfolio);
});

connectDB().then(() => { bot.launch(); console.log('🤖 Bot is running!'); });
