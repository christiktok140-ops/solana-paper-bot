require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

const ADMIN_ID = 8490406962;
const PAYMENT_WALLET = '9JnEAYUSqp2aTuL2DXmYUko3mYEY5oXj8YCGke5MLHN7';
const MONTHLY_PRICE_USD = 30;
const TRIAL_DAYS = 0;

let db, portfoliosCollection, usersCollection, vipCollection;

async function connectDB() {
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
        await portfoliosCollection.updateOne({ userId: String(userId) }, { $set: { userId: String(userId), virtualUsd: portfolio.virtualUsd, holdings: holdingsObj, trades: portfolio.trades.slice(0, 500), updatedAt: new Date() } }, { upsert: true });
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
    if (userId === ADMIN_ID) return true;
    if (await isVip(userId)) return true;
    const user = await getUserAccess(userId);
    if (!user) return false;
    if (user.subscribedUntil && new Date(user.subscribedUntil) > new Date()) return true;
    return false;
}

async function startTrial(userId) {
    try {
        const existing = await usersCollection.findOne({ userId: String(userId) });
        if (existing) return existing;
        await usersCollection.insertOne({ userId: String(userId), trialStarted: new Date(), subscribedUntil: null, createdAt: new Date() });
        return await usersCollection.findOne({ userId: String(userId) });
    } catch (e) { console.log(e.message); }
}

async function activateSubscription(userId, months = 1) {
    try {
        const user = await usersCollection.findOne({ userId: String(userId) });
        const now = new Date();
        let startFrom = now;
        if (user?.subscribedUntil && new Date(user.subscribedUntil) > now) startFrom = new Date(user.subscribedUntil);
        const newExpiry = new Date(startFrom);
        newExpiry.setMonth(newExpiry.getMonth() + months);
        await usersCollection.updateOne({ userId: String(userId) }, { $set: { subscribedUntil: newExpiry, updatedAt: now } }, { upsert: true });
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
        const tokenData = { name: pair.baseToken?.name || 'Unknown', symbol: pair.baseToken?.symbol || '???', mintAddress: pair.baseToken?.address || mintAddress, priceUsd: parseFloat(pair.priceUsd) || 0, marketCap: pair.fdv || pair.marketCap || 0, liquidity: pair.liquidity?.usd || 0, volume24h: pair.volume?.h24 || 0, priceChange24h: pair.priceChange?.h24 || 0, exchange: pair.dexId || 'DexScreener', pooledUsdc: pair.liquidity?.quote || 0, imageUrl: pair.info?.imageUrl || null };
        priceCache.set(mintAddress, { data: tokenData, timestamp: Date.now() });
        return tokenData;
    } catch (error) { return null; }
}

async function initializeUser(userId) {
    if (!userPortfolios.has(userId)) {
        const saved = await loadUser(userId);
        userPortfolios.set(userId, { virtualUsd: saved?.virtualUsd ?? 1000.0, holdings: saved?.holdings ?? new Map(), trades: saved?.trades ?? [], cards: new Map(), currentMint: null, pendingAction: null, currentTokenData: null, lastMessageId: null, lastMessageHasPhoto: false, pendingMessageId: null });
    }
    return userPortfolios.get(userId);
}

function shortCA(addr) { return `${addr.slice(0, 8)}...${addr.slice(-4)}`; }

function formatUsd(num) { if (num >= 1000000) return `$${(num / 1000000).toFixed(2)}M`; if (num >= 1000) return `$${(num / 1000).toFixed(1)}K`; return `$${num.toFixed(2)}`; }

function formatTokenMessage(tokenData, portfolio) {
    const changeEmoji = tokenData.priceChange24h >= 0 ? '🟢' : '🔴';
    const changeSign = tokenData.priceChange24h >= 0 ? '+' : '';
    return `🔍 Search on X\n⚡ ${tokenData.exchange.toUpperCase()} • ${tokenData.name} ($${tokenData.symbol})\n${changeEmoji} ${changeSign}${tokenData.priceChange24h.toFixed(2)}%\n\n─────────────────\n📊 MARKET INFO\n─────────────────\n💰 Market Cap: ${formatUsd(tokenData.marketCap)}\n💧 Liquidity: ${formatUsd(tokenData.liquidity)}\n💵 Price: $${tokenData.priceUsd.toFixed(8)}\n\n─────────────────\n👛 YOUR WALLET\n─────────────────\n💵 Balance: $${portfolio.virtualUsd.toFixed(2)}`;
}

function formatHoldingMessage(tokenData, holding, portfolio) {
    const currentValueUsd = holding.amount * tokenData.priceUsd;
    const initialValueUsd = holding.amountUsd;
    const pnlUsd = currentValueUsd - initialValueUsd;
    const pnlPercent = (pnlUsd / initialValueUsd) * 100;
    const pnlEmoji = pnlUsd >= 0 ? '🟢' : '🔴';
    const pnlSign = pnlUsd >= 0 ? '+' : '';
    const entryMcap = holding.marketCapAtBuy ? formatUsd(holding.marketCapAtBuy) : 'N/A';
    return `🔍 Search on X\n⚡ ${tokenData.exchange.toUpperCase()} • ${tokenData.name} ($${tokenData.symbol})\n${pnlEmoji} ${pnlSign}${pnlPercent.toFixed(2)}%\n\n─────────────────\n📈 YOUR POSITION\n─────────────────\n💰 Invested: $${initialValueUsd.toFixed(2)}\n💎 Now Worth: $${currentValueUsd.toFixed(2)}\n${pnlEmoji} PnL: ${pnlSign}$${pnlUsd.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(2)}%)\n📊 Entry MCap: ${entryMcap}\n\n─────────────────\n📊 MARKET INFO\n─────────────────\n💧 Liquidity: ${formatUsd(tokenData.liquidity)}\n💡 Current MCap: ${formatUsd(tokenData.marketCap)}\n💵 Price: $${tokenData.priceUsd.toFixed(8)}\n\n─────────────────\n🏦 Balance: $${portfolio.virtualUsd.toFixed(2)}\n📊 Holdings: ${holding.amount.toFixed(2)} ${tokenData.symbol}`;
}

function getTokenButtons(hasHolding) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'refresh'), Markup.button.callback('🗑 Delete', 'delete_card'), Markup.button.callback('👤 Profile', 'profile')],
        [Markup.button.callback('Buy $10', 'buy_10'), Markup.button.callback('Buy $50', 'buy_50'), Markup.button.callback('Buy $100', 'buy_100')],
        [Markup.button.callback('Buy $200', 'buy_200'), Markup.button.callback('Buy $X', 'buy_x')],
        [Markup.button.callback(hasHolding ? 'Sell' : 'Sell ❌', 'paper_sell')]
    ]);
}

async function paperBuy(userId, mint, tokenData, amountUsd) {
    const portfolio = userPortfolios.get(userId);
    if (!portfolio) return { success: false, error: 'No portfolio' };
    if (portfolio.virtualUsd < amountUsd) return { success: false, error: `Only $${portfolio.virtualUsd.toFixed(2)}` };
    const fee = amountUsd * 0.01;
    const total = amountUsd + fee;
    if (portfolio.virtualUsd < total) return { success: false, error: `Need $${total.toFixed(2)} inc fee` };
    const tokenAmount = amountUsd / tokenData.priceUsd;
    const current = portfolio.holdings.get(mint) || { amount: 0, avgPrice: 0, amountUsd: 0, marketCapAtBuy: 0 };
    const newAmount = current.amount + tokenAmount;
    const newAvg = ((current.amount * current.avgPrice) + amountUsd) / newAmount;
    const totalMcap = (current.amountUsd * (current.marketCapAtBuy || 0)) + (amountUsd * tokenData.marketCap);
    const newAvgMcap = totalMcap / (current.amountUsd + amountUsd);
    portfolio.virtualUsd -= total;
    portfolio.holdings.set(mint, { amount: newAmount, avgPrice: newAvg, amountUsd: (current.amountUsd || 0) + amountUsd, marketCapAtBuy: newAvgMcap });
    portfolio.trades.unshift({ type: 'BUY', token: tokenData.symbol, amountUsd, fee, tokenAmount, price: tokenData.priceUsd, marketCapAtBuy: tokenData.marketCap, time: new Date().toLocaleTimeString() });
    await saveUser(userId, portfolio);
    return { success: true, remainingUsd: portfolio.virtualUsd, fee };
}

async function paperSell(userId, mint, tokenData, percent) {
    const portfolio = userPortfolios.get(userId);
    if (!portfolio) return { success: false, error: 'No portfolio' };
    const holding = portfolio.holdings.get(mint);
    if (!holding || holding.amount === 0) return { success: false, error: "No holdings" };
    const sellAmount = holding.amount * (percent / 100);
    const gross = sellAmount * tokenData.priceUsd;
    const fee = gross * 0.01;
    const revenue = gross - fee;
    const costBasis = holding.avgPrice * sellAmount;
    const profit = revenue - costBasis;
    const profitPercent = (profit / costBasis) * 100;
    portfolio.virtualUsd += revenue;
    const remaining = holding.amount - sellAmount;
    if (remaining < 0.01) { portfolio.holdings.delete(mint); }
    else { portfolio.holdings.set(mint, { amount: remaining, avgPrice: holding.avgPrice, amountUsd: holding.amountUsd * (1 - percent / 100), marketCapAtBuy: holding.marketCapAtBuy }); }
    portfolio.trades.unshift({ type: 'SELL', token: tokenData.symbol, amountUsd: revenue, fee, sellAmount, price: tokenData.priceUsd, profit, profitPercent, marketCapAtBuy: holding.marketCapAtBuy, marketCapAtSell: tokenData.marketCap, investedAmount: (sellAmount / (percent / 100)) * holding.avgPrice, time: new Date().toLocaleTimeString() });
    await saveUser(userId, portfolio);
    return { success: true, remainingUsd: portfolio.virtualUsd, profit, profitPercent, fee, entryMcap: holding.marketCapAtBuy, exitMcap: tokenData.marketCap, investedAmount: (sellAmount / (percent / 100)) * holding.avgPrice };
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
    if (userId === ADMIN_ID) return next();
    const text = ctx.message?.text || '';
    if (text === '/start' || text === '/pay') return next();
    if (await hasAccess(userId)) return next();
    const solRequired = await getRequiredSol();
    await ctx.reply(`🔒 Access Required\nSubscribe $${MONTHLY_PRICE_USD}/month\nPay: ${solRequired.toFixed(4)} SOL\n\nSend to: ${PAYMENT_WALLET}\n\nContact @Supryme_loves_memecoins after payment`);
}
bot.use(checkAccess);

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    await startTrial(userId);
    await initializeUser(userId);
    const p = userPortfolios.get(userId);
    await ctx.reply(`🎮 SUPRYME TRADING\n💰 Balance: $${p.virtualUsd.toFixed(2)}\n📦 Holdings: ${p.holdings.size}\n\nSend any Solana contract address to start\n\n/history - /portfolio - /pay`);
});

bot.command('pay', async (ctx) => {
    const solRequired = await getRequiredSol();
    await ctx.reply(`💳 Subscribe\n$${MONTHLY_PRICE_USD}/month\nPay: ${solRequired.toFixed(4)} SOL\n\nSend to: ${PAYMENT_WALLET}\n\nContact @Supryme_loves_memecoins after payment`);
});

bot.command('addvip', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /addvip ID');
    await vipCollection.updateOne({ userId: args[1] }, { $set: { userId: args[1], addedAt: new Date() } }, { upsert: true });
    await ctx.reply(`✅ Added VIP`);
});

bot.command('removevip', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /removevip ID');
    await vipCollection.deleteOne({ userId: args[1] });
    await ctx.reply(`✅ Removed VIP`);
});

bot.command('listvip', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const vips = await vipCollection.find({}).toArray();
    if (vips.length === 0) return ctx.reply('No VIP users');
    await ctx.reply(vips.map(v => v.userId).join('\n'));
});

bot.command('grantaccess', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /grantaccess ID [months]');
    const months = parseInt(args[2]) || 1;
    await usersCollection.updateOne({ userId: args[1] }, { $set: { userId: args[1], trialStarted: new Date() } }, { upsert: true });
    const expiry = await activateSubscription(args[1], months);
    await ctx.reply(`✅ Granted ${months} month(s)\nExpires: ${expiry.toLocaleDateString()}`);
});

bot.command('users', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const total = await usersCollection.countDocuments();
    const subscribed = await usersCollection.countDocuments({ subscribedUntil: { $gt: new Date() } });
    await ctx.reply(`📊 Stats\nTotal: ${total}\nSubscribed: ${subscribed}`);
});

bot.command('test', async (ctx) => {
    const result = await getTokenData('So11111111111111111111111111111111111111112');
    await ctx.reply(result ? `✅ API Works! Price: $${result.priceUsd}` : '❌ Failed');
});

bot.command('refill', async (ctx) => {
    const userId = ctx.from.id;
    userPortfolios.set(userId, { virtualUsd: 1000.0, holdings: new Map(), trades: [], cards: new Map(), currentMint: null, pendingAction: null, currentTokenData: null, lastMessageId: null, lastMessageHasPhoto: false, pendingMessageId: null });
    await saveUser(userId, userPortfolios.get(userId));
    await ctx.reply('✅ Refilled! $1,000');
});

bot.command('portfolio', async (ctx) => {
    const userId = ctx.from.id;
    await initializeUser(userId);
    const p = userPortfolios.get(userId);
    let msg = `📁 Portfolio\nBalance: $${p.virtualUsd.toFixed(2)}\nHoldings: ${p.holdings.size}\n\n`;
    for (const [mint, h] of p.holdings) msg += `${shortCA(mint)}: ${h.amount.toFixed(2)} tokens @ $${h.avgPrice.toFixed(8)}\n`;
    await ctx.reply(msg || 'No holdings');
});

bot.command('history', async (ctx) => {
    const userId = ctx.from.id;
    await initializeUser(userId);
    const p = userPortfolios.get(userId);
    const sells = p.trades.filter(t => t.type === 'SELL');
    if (sells.length === 0) return ctx.reply('No trades');
    let msg = `📜 Last ${Math.min(5, sells.length)} trades:\n\n`;
    for (const t of sells.slice(0, 5)) {
        msg += `${t.type} ${t.token}\n💰 $${t.amountUsd.toFixed(2)}\n${t.profit >= 0 ? '✅' : '❌'} PnL: ${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)}\n⏱️ ${t.time}\n\n`;
    }
    await ctx.reply(msg);
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    await initializeUser(userId);
    const p = userPortfolios.get(userId);
    
    if (p.pendingAction === 'buy_x') {
        const amount = parseFloat(text);
        if (isNaN(amount)) { p.pendingAction = null; return ctx.reply('Invalid amount'); }
        p.pendingAction = null;
        const result = await paperBuy(userId, p.currentMint, p.currentTokenData, amount);
        if (!result.success) return ctx.reply(result.error);
        await ctx.reply(`✅ Bought $${amount}\nFee: $${result.fee.toFixed(2)}\nBalance: $${result.remainingUsd.toFixed(2)}`);
        await updateTokenCard(ctx, p.currentTokenData, p);
        return;
    }
    
    if (p.pendingAction === 'sell_x') {
        const percent = parseFloat(text);
        if (isNaN(percent) || percent < 1 || percent > 100) { p.pendingAction = null; return ctx.reply('Enter 1-100'); }
        p.pendingAction = null;
        const result = await paperSell(userId, p.currentMint, p.currentTokenData, percent);
        if (!result.success) return ctx.reply(result.error);
        await ctx.reply(`${result.profit >= 0 ? '✅' : '❌'} Sold ${percent}%\nPnL: ${result.profit >= 0 ? '+' : ''}$${result.profit.toFixed(2)}\nBalance: $${result.remainingUsd.toFixed(2)}`);
        await updateTokenCard(ctx, p.currentTokenData, p);
        return;
    }
    
    const loading = await ctx.reply('⏳ Fetching...');
    p.currentMint = text;
    const tokenData = await getTokenData(text);
    await ctx.deleteMessage(loading.message_id).catch(() => {});
    if (!tokenData) return ctx.reply('Token not found');
    p.currentTokenData = tokenData;
    await sendTokenCard(ctx, tokenData, p);
});

for (const amt of [10, 50, 100, 200]) {
    bot.action(`buy_${amt}`, async (ctx) => {
        const userId = ctx.from.id;
        const p = userPortfolios.get(userId);
        const card = p?.cards.get(ctx.callbackQuery.message.message_id);
        if (!card) return ctx.answerCbQuery('No token');
        await ctx.answerCbQuery();
        const result = await paperBuy(userId, card.mint, card.tokenData, amt);
        if (!result.success) return ctx.reply(result.error);
        await ctx.reply(`✅ Bought $${amt}\nFee: $${result.fee.toFixed(2)}\nBalance: $${result.remainingUsd.toFixed(2)}`);
        const fresh = await getTokenData(card.mint);
        if (fresh) card.tokenData = fresh;
        await updateTokenCard(ctx, card.tokenData, p);
    });
}

bot.action('buy_x', async (ctx) => {
    const userId = ctx.from.id;
    const p = userPortfolios.get(userId);
    const card = p?.cards.get(ctx.callbackQuery.message.message_id);
    if (!card) return ctx.answerCbQuery('No token');
    await ctx.answerCbQuery();
    p.pendingAction = 'buy_x';
    p.currentMint = card.mint;
    p.currentTokenData = card.tokenData;
    await ctx.reply('💰 Send amount in USD (e.g. 25)');
});

bot.action('paper_sell', async (ctx) => {
    const userId = ctx.from.id;
    const p = userPortfolios.get(userId);
    const card = p?.cards.get(ctx.callbackQuery.message.message_id);
    if (!card) return ctx.answerCbQuery('No token');
    const holding = p?.holdings.get(card.mint);
    if (!holding || holding.amount === 0) return ctx.answerCbQuery('No holdings');
    await ctx.answerCbQuery();
    p.pendingAction = 'sell_x';
    p.currentMint = card.mint;
    p.currentTokenData = card.tokenData;
    await ctx.reply('💸 Send percentage (e.g. 50)');
});

bot.action('refresh', async (ctx) => {
    const userId = ctx.from.id;
    const p = userPortfolios.get(userId);
    const card = p?.cards.get(ctx.callbackQuery.message.message_id);
    if (!card) return ctx.answerCbQuery('No token');
    await ctx.answerCbQuery('Refreshing...');
    const fresh = await getTokenData(card.mint);
    if (!fresh) return ctx.answerCbQuery('Failed');
    card.tokenData = fresh;
    await updateTokenCard(ctx, fresh, p);
});

bot.action('delete_card', async (ctx) => {
    const userId = ctx.from.id;
    const p = userPortfolios.get(userId);
    await ctx.answerCbQuery('Deleted');
    await ctx.deleteMessage().catch(() => {});
    p.cards.delete(ctx.callbackQuery.message.message_id);
});

connectDB().then(() => { bot.launch(); console.log('Bot running!'); });
