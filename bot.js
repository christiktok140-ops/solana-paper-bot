require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const ADMIN_ID = '8490406962';
const PAYMENT_WALLET = '9JnEAYUSqp2aTuL2DXmYUko3mYEY5oXj8YCGke5MLHN7';
const MONTHLY_PRICE_USD = 30;
const TRIAL_DAYS = 0;

// JSON file paths for data storage
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PORTFOLIOS_FILE = path.join(DATA_DIR, 'portfolios.json');
const VIP_FILE = path.join(DATA_DIR, 'vip.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Load/Save helper functions
function loadJSON(file, defaultValue = {}) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
        return defaultValue;
    } catch (e) { return defaultValue; }
}

function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Data stores
let usersData = loadJSON(USERS_FILE, {});
let portfoliosData = loadJSON(PORTFOLIOS_FILE, {});
let vipData = loadJSON(VIP_FILE, {});

function saveAll() {
    saveJSON(USERS_FILE, usersData);
    saveJSON(PORTFOLIOS_FILE, portfoliosData);
    saveJSON(VIP_FILE, vipData);
}

// Helper functions
function getUserData(userId) {
    if (!portfoliosData[userId]) {
        portfoliosData[userId] = {
            virtualUsd: 1000.0,
            holdings: {},
            trades: []
        };
    }
    return portfoliosData[userId];
}

function saveUserData(userId, data) {
    portfoliosData[userId] = data;
    saveJSON(PORTFOLIOS_FILE, portfoliosData);
}

function isVip(userId) {
    return vipData[userId] === true;
}

function addVip(userId) {
    vipData[userId] = true;
    saveJSON(VIP_FILE, vipData);
}

function removeVip(userId) {
    delete vipData[userId];
    saveJSON(VIP_FILE, vipData);
}

function hasAccess(userId) {
    if (userId === ADMIN_ID) return true;
    if (isVip(userId)) return true;
    if (usersData[userId] && usersData[userId].subscribedUntil) {
        if (new Date(usersData[userId].subscribedUntil) > new Date()) return true;
    }
    return false;
}

function startTrial(userId) {
    if (!usersData[userId]) {
        usersData[userId] = { trialStarted: new Date().toISOString(), subscribedUntil: null };
        saveJSON(USERS_FILE, usersData);
    }
}

function activateSubscription(userId, months = 1) {
    const now = new Date();
    let startFrom = now;
    if (usersData[userId] && usersData[userId].subscribedUntil && new Date(usersData[userId].subscribedUntil) > now) {
        startFrom = new Date(usersData[userId].subscribedUntil);
    }
    const newExpiry = new Date(startFrom);
    newExpiry.setMonth(newExpiry.getMonth() + months);
    usersData[userId] = { ...usersData[userId], subscribedUntil: newExpiry.toISOString() };
    saveJSON(USERS_FILE, usersData);
    return newExpiry;
}

async function getSolPrice() {
    try {
        const res = await axios.get('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', { timeout: 5000 });
        const pair = res.data.pairs?.[0];
        return pair ? parseFloat(pair.priceUsd) : 150;
    } catch { return 150; }
}

async function getRequiredSol() { const solPrice = await getSolPrice(); return MONTHLY_PRICE_USD / solPrice; }

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
    const portfolio = getUserData(userId);
    if (portfolio.virtualUsd < amountUsd) return { success: false, error: `You only have $${portfolio.virtualUsd.toFixed(2)}` };
    const buyFee = amountUsd * 0.01;
    const totalCost = amountUsd + buyFee;
    if (portfolio.virtualUsd < totalCost) return { success: false, error: `Need $${totalCost.toFixed(2)} inc. 1% fee` };
    const tokenAmount = amountUsd / tokenData.priceUsd;
    const currentHolding = portfolio.holdings[mint] || { amount: 0, avgPrice: 0, amountUsd: 0, marketCapAtBuy: 0 };
    const totalTokens = currentHolding.amount + tokenAmount;
    const totalCostUsd = (currentHolding.amount * currentHolding.avgPrice) + amountUsd;
    const newAvgPrice = totalCostUsd / totalTokens;
    const totalMcapAtBuy = (currentHolding.amountUsd * (currentHolding.marketCapAtBuy || 0)) + (amountUsd * tokenData.marketCap);
    const newAvgMcapAtBuy = totalMcapAtBuy / totalCostUsd;
    portfolio.virtualUsd -= totalCost;
    portfolio.holdings[mint] = { amount: totalTokens, avgPrice: newAvgPrice, amountUsd: (currentHolding.amountUsd || 0) + amountUsd, marketCapAtBuy: newAvgMcapAtBuy };
    portfolio.trades.unshift({ type: 'BUY', token: tokenData.symbol, amountUsd, fee: buyFee, tokenAmount, price: tokenData.priceUsd, marketCapAtBuy: tokenData.marketCap, time: new Date().toLocaleTimeString() });
    saveUserData(userId, portfolio);
    return { success: true, tokenAmount, costUsd: totalCost, fee: buyFee, remainingUsd: portfolio.virtualUsd, marketCapAtBuy: tokenData.marketCap };
}

async function paperSell(userId, mint, tokenData, percentToSell) {
    const portfolio = getUserData(userId);
    const holding = portfolio.holdings[mint];
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
    if (remainingAmount < 0.01) { delete portfolio.holdings[mint]; }
    else { portfolio.holdings[mint] = { amount: remainingAmount, avgPrice: holding.avgPrice, amountUsd: holding.amountUsd * (1 - percentToSell / 100), marketCapAtBuy: holding.marketCapAtBuy }; }
    portfolio.trades.unshift({ type: 'SELL', token: tokenData.symbol, amountUsd: revenueUsd, fee: sellFee, tokenAmount, price: tokenData.priceUsd, profitUsd, profitPercent, marketCapAtBuy: holding.marketCapAtBuy, marketCapAtSell: tokenData.marketCap, investedAmount: (tokenAmount / (percentToSell / 100)) * holding.avgPrice, time: new Date().toLocaleTimeString() });
    saveUserData(userId, portfolio);
    return { success: true, revenueUsd, fee: sellFee, profitUsd, profitPercent, remainingUsd: portfolio.virtualUsd, entryMcap: holding.marketCapAtBuy, exitMcap: tokenData.marketCap, investedAmount: (tokenAmount / (percentToSell / 100)) * holding.avgPrice };
}

// User tracking for cards
const userCards = new Map();

async function updateTokenCard(ctx, tokenData, userId, messageId) {
    const portfolio = getUserData(userId);
    const holding = portfolio.holdings[tokenData.mintAddress];
    const buttons = getTokenButtons(!!holding);
    const message = holding ? formatHoldingMessage(tokenData, holding, portfolio) : formatTokenMessage(tokenData, portfolio);
    try {
        await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, message, { parse_mode: 'Markdown', reply_markup: buttons.reply_markup });
    } catch (e) { if (!e.message?.includes('message is not modified')) console.log(e.message); }
}

async function sendTokenCard(ctx, tokenData, userId) {
    const portfolio = getUserData(userId);
    const holding = portfolio.holdings[tokenData.mintAddress];
    const buttons = getTokenButtons(!!holding);
    const message = holding ? formatHoldingMessage(tokenData, holding, portfolio) : formatTokenMessage(tokenData, portfolio);
    let sent;
    if (tokenData.imageUrl) {
        sent = await ctx.replyWithPhoto(tokenData.imageUrl, { caption: message, parse_mode: 'Markdown', reply_markup: buttons.reply_markup });
    } else {
        sent = await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: buttons.reply_markup });
    }
    if (!userCards.has(userId)) userCards.set(userId, new Map());
    userCards.get(userId).set(sent.message_id, tokenData.mintAddress);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

async function checkAccess(ctx, next) {
    const userId = String(ctx.from?.id);
    if (!userId) return next();
    if (userId === ADMIN_ID) return next();
    const text = ctx.message?.text || '';
    if (text === '/start' || text === '/pay') return next();
    if (hasAccess(userId)) return next();
    const solRequired = await getRequiredSol();
    await ctx.reply(
        `🔒 *Access Required*\n─────────────────\n\nSubscribe for *$${MONTHLY_PRICE_USD}/month*\n💰 Pay: *${solRequired.toFixed(4)} SOL*\n\n─────────────────\n📤 *Send SOL to:*\n\`${PAYMENT_WALLET}\`\n\n─────────────────\n⚠️ *After sending SOL:*\nContact @Supryme_loves_memecoins with transaction proof\n\n─────────────────`,
        { parse_mode: 'Markdown' }
    );
}
bot.use(checkAccess);

bot.start(async (ctx) => {
    const userId = String(ctx.from.id);
    startTrial(userId);
    const portfolio = getUserData(userId);
    let accessLine = '';
    if (userId === ADMIN_ID || isVip(userId)) { accessLine = `✅ *Access: Lifetime Free*\n`; }
    else if (usersData[userId]?.subscribedUntil && new Date(usersData[userId].subscribedUntil) > new Date()) { accessLine = `✅ *Subscribed until: ${new Date(usersData[userId].subscribedUntil).toLocaleDateString()}*\n`; }
    else { accessLine = `⚠️ *No active subscription — /pay to subscribe*\n`; }
    const divider = `─────────────────`;
    const name = ctx.from.first_name || 'Trader';
    const caption =
        `💎 *Welcome, ${name}!*\n${divider}\n\n🚀 *SUPRYME DEMO TRADING*\n\nTrade real Solana memecoins with virtual money. Live blockchain prices, real tokens — no simulations.\n\n${divider}\n\n${accessLine}${divider}\n\n💵 Balance:   *$${portfolio.virtualUsd.toFixed(2)}*\n📦 Holdings:  *${Object.keys(portfolio.holdings).length}*\n📊 Trades:    *${portfolio.trades.filter(t => t.type === 'SELL').length}*\n\n${divider}\n\n✨ *Paste any Solana CA to start*\n\n${divider}\n📜 /history  •  👤 /portfolio  •  💰 /pay\n\n⚡ _Created by Supryme_`;
    await ctx.reply(caption, { parse_mode: 'Markdown' });
});

bot.command('pay', async (ctx) => {
    const solRequired = await getRequiredSol();
    const solPrice = await getSolPrice();
    const userId = ctx.from.id;
    await ctx.reply(
        `💳 *Subscribe to Supryme Demo Trading*\n─────────────────\n\n💵 Price: *$${MONTHLY_PRICE_USD}/month*\n💰 Pay: *${solRequired.toFixed(4)} SOL*\n📊 SOL Price: *$${solPrice.toFixed(2)}*\n\n─────────────────\n📤 *Send SOL to:*\n\`${PAYMENT_WALLET}\`\n\n─────────────────\n⚠️ *After sending SOL:*\n1️⃣ Take a screenshot\n2️⃣ Send to @Supryme_loves_memecoins\n3️⃣ Include your Telegram ID: \`${userId}\`\n\n─────────────────\n💡 *Once verified, you will get access within 24 hours*`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('addvip', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /addvip TELEGRAM_ID');
    addVip(args[1]);
    await ctx.reply(`✅ Added ${args[1]} to VIP list`);
});

bot.command('removevip', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /removevip TELEGRAM_ID');
    removeVip(args[1]);
    await ctx.reply(`✅ Removed ${args[1]} from VIP list`);
});

bot.command('listvip', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const vips = Object.keys(vipData);
    if (vips.length === 0) return ctx.reply('No VIP users.');
    await ctx.reply(`👑 *VIP Users (${vips.length})*\n\n${vips.map((v, i) => `${i + 1}. ${v}`).join('\n')}`, { parse_mode: 'Markdown' });
});

bot.command('grantaccess', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /grantaccess TELEGRAM_ID [months]');
    const months = parseInt(args[2]) || 1;
    const expiry = activateSubscription(args[1], months);
    await ctx.reply(`✅ Granted ${months} month(s) access to ${args[1]}\nExpires: ${expiry.toLocaleDateString()}`);
});

bot.command('users', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;
    const total = Object.keys(usersData).length;
    let subscribed = 0;
    for (const [id, data] of Object.entries(usersData)) {
        if (data.subscribedUntil && new Date(data.subscribedUntil) > new Date()) subscribed++;
    }
    await ctx.reply(`📊 *Bot Stats*\n\n👥 Total Users: *${total}*\n✅ Subscribed: *${subscribed}*\n⏳ Expired/Trial: *${total - subscribed}*`, { parse_mode: 'Markdown' });
});

bot.command('test', async (ctx) => {
    const result = await getTokenData('So11111111111111111111111111111111111111112');
    await ctx.reply(result ? `✅ API Working! Price: $${result.priceUsd}` : '❌ Failed');
});

bot.command('refill', async (ctx) => {
    const userId = String(ctx.from.id);
    portfoliosData[userId] = { virtualUsd: 1000.0, holdings: {}, trades: [] };
    saveJSON(PORTFOLIOS_FILE, portfoliosData);
    await ctx.reply('✅ Portfolio refilled! You have $1,000.00');
});

async function buildProfileMessage(userId) {
    const portfolio = getUserData(userId);
    let totalPnl = 0, totalSold = 0;
    for (let trade of portfolio.trades) { if (trade.type === 'SELL' && trade.profitUsd !== undefined) { totalPnl += trade.profitUsd; totalSold += trade.amountUsd; } }
    const totalPnlPct = totalSold > 0 ? (totalPnl / totalSold) * 100 : 0;
    const pnlEmoji = totalPnl >= 0 ? '🟢' : '🔴';
    const pnlSign = totalPnl >= 0 ? '+' : '';
    let message = `👤 *PROFILE*\n─────────────────\n\n🎯 Balance:      *$${portfolio.virtualUsd.toFixed(2)}*\n─────────────────\n\n💰 Initial:      *$1000.00*\n💸 Sold:         *$${totalSold.toFixed(2)}*\n${pnlEmoji} Current PnL:  *${pnlSign}$${totalPnl.toFixed(2)} (${pnlSign}${totalPnlPct.toFixed(2)}%)*\n\n─────────────────\n`;
    if (Object.keys(portfolio.holdings).length > 0) { message += `\n📦 *Open Positions (${Object.keys(portfolio.holdings).length})*\n─────────────────\n`; for (const [mint, holding] of Object.entries(portfolio.holdings)) { message += `• *${shortCA(mint)}* — $${holding.amountUsd.toFixed(2)} invested\n`; } message += `\n`; } else { message += `\n📦 No open positions\n\n`; }
    message += `─────────────────\n📜 Trades:  *${portfolio.trades.filter(t => t.type === 'SELL').length}*\n─────────────────`;
    return message;
}

bot.command('portfolio', async (ctx) => {
    const userId = String(ctx.from.id);
    const message = await buildProfileMessage(userId);
    await ctx.reply(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) });
});

bot.command('history', async (ctx) => {
    const userId = String(ctx.from.id);
    const portfolio = getUserData(userId);
    const sells = portfolio.trades.filter(t => t.type === 'SELL');
    if (sells.length === 0) return ctx.reply('No completed trades yet.');
    let wins = 0, losses = 0, totalPnl = 0;
    for (const trade of sells) { if (trade.profitUsd > 0) wins++; else if (trade.profitUsd < 0) losses++; totalPnl += trade.profitUsd; }
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
    const message = await buildProfileMessage(userId);
    await ctx.reply(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) });
});

bot.action('close_profile', async (ctx) => { await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch (e) {} });

// Pending actions storage
const pendingActions = {};

bot.on('text', async (ctx) => {
    const userId = String(ctx.from.id);
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    
    const portfolio = getUserData(userId);
    
    if (pendingActions[userId]?.action === 'buy_x') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) { delete pendingActions[userId]; return ctx.reply('❌ Send a valid number.'); }
        const mint = pendingActions[userId].mint;
        const tokenData = pendingActions[userId].tokenData;
        const messageId = pendingActions[userId].messageId;
        delete pendingActions[userId];
        const result = await paperBuy(userId, mint, tokenData, amount);
        if (!result.success) return ctx.reply(`❌ ${result.error}`);
        await ctx.reply(
            `✅ *BUY EXECUTED*\n─────────────────\n💚 Amount:    *$${amount.toFixed(2)}*\n📊 Entry MCap: *$${tokenData.marketCap.toLocaleString()}*\n💸 Fee:       *$${result.fee.toFixed(2)}* _(1%)_\n🏦 Balance:   *$${result.remainingUsd.toFixed(2)}*\n─────────────────\n🎮 _Demo Trade by Supryme_`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) }
        );
        const fresh = await getTokenData(mint);
        if (fresh) await updateTokenCard(ctx, fresh, userId, messageId);
        return;
    }
    
    if (pendingActions[userId]?.action === 'sell_x') {
        const percent = parseFloat(text);
        if (isNaN(percent) || percent <= 0 || percent > 100) { delete pendingActions[userId]; return ctx.reply('❌ Send a number between 1 and 100.'); }
        const mint = pendingActions[userId].mint;
        const tokenData = pendingActions[userId].tokenData;
        const messageId = pendingActions[userId].messageId;
        delete pendingActions[userId];
        const result = await paperSell(userId, mint, tokenData, percent);
        if (!result.success) return ctx.reply(`❌ ${result.error}`);
        const sign = result.profitUsd >= 0 ? '+' : '';
        await ctx.reply(
            `${result.profitUsd >= 0 ? '🟢' : '🔴'} *SELL EXECUTED*\n─────────────────\n💰 Invested:   *$${result.investedAmount?.toFixed(2) || 'N/A'}*\n📊 Entry MCap: *$${result.entryMcap?.toLocaleString() || 'N/A'}*\n📊 Exit MCap:  *$${tokenData.marketCap.toLocaleString()}*\n${result.profitUsd >= 0 ? '🟢' : '🔴'} P&L:       *${sign}$${result.profitUsd.toFixed(2)} (${sign}${result.profitPercent.toFixed(2)}%)*\n💸 Fee:        *$${result.fee.toFixed(2)}* _(1%)_\n🏦 Balance:    *$${result.remainingUsd.toFixed(2)}*\n─────────────────\n🎮 _Demo Trade by Supryme_`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) }
        );
        const fresh = await getTokenData(mint);
        if (fresh) await updateTokenCard(ctx, fresh, userId, messageId);
        return;
    }
    
    const loading = await ctx.reply(`🔍 Fetching token data...`);
    const tokenData = await getTokenData(text);
    await ctx.deleteMessage(loading.message_id).catch(() => {});
    if (!tokenData) return ctx.reply('❌ Token not found.');
    await sendTokenCard(ctx, tokenData, userId);
});

for (const amount of [10, 25, 50, 100, 200]) {
    bot.action(`buy_${amount}`, async (ctx) => {
        const userId = String(ctx.from.id);
        const messageId = ctx.callbackQuery.message.message_id;
        const cards = userCards.get(userId);
        const mint = cards?.get(messageId);
        if (!mint) return ctx.answerCbQuery('Send a contract address first.');
        await ctx.answerCbQuery(`Buying $${amount}...`);
        const tokenData = await getTokenData(mint);
        if (!tokenData) return ctx.reply('Error fetching token data');
        const result = await paperBuy(userId, mint, tokenData, amount);
        if (!result.success) return ctx.reply(`❌ ${result.error}`);
        await ctx.reply(
            `✅ *BUY EXECUTED*\n─────────────────\n💚 Amount:    *$${amount.toFixed(2)}*\n📊 Entry MCap: *$${tokenData.marketCap.toLocaleString()}*\n💸 Fee:       *$${result.fee.toFixed(2)}* _(1%)_\n🏦 Balance:   *$${result.remainingUsd.toFixed(2)}*\n─────────────────\n🎮 _Demo Trade by Supryme_`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) }
        );
        const fresh = await getTokenData(mint);
        if (fresh) await updateTokenCard(ctx, fresh, userId, messageId);
    });
}

bot.action('buy_x', async (ctx) => {
    const userId = String(ctx.from.id);
    const messageId = ctx.callbackQuery.message.message_id;
    const cards = userCards.get(userId);
    const mint = cards?.get(messageId);
    if (!mint) return ctx.answerCbQuery('Send a contract address first.');
    await ctx.answerCbQuery();
    const tokenData = await getTokenData(mint);
    if (!tokenData) return ctx.reply('Error fetching token data');
    pendingActions[userId] = { action: 'buy_x', mint, tokenData, messageId };
    await ctx.reply('💰 Send the amount in USD you want to buy (e.g. 25):', Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]));
});

bot.action('paper_sell', async (ctx) => {
    const userId = String(ctx.from.id);
    const messageId = ctx.callbackQuery.message.message_id;
    const cards = userCards.get(userId);
    const mint = cards?.get(messageId);
    if (!mint) return ctx.answerCbQuery('No token selected.');
    const portfolio = getUserData(userId);
    const holding = portfolio.holdings[mint];
    if (!holding || holding.amount === 0) return ctx.answerCbQuery("❌ You don't hold this token.");
    await ctx.answerCbQuery();
    const tokenData = await getTokenData(mint);
    if (!tokenData) return ctx.reply('Error fetching token data');
    pendingActions[userId] = { action: 'sell_x', mint, tokenData, messageId };
    const sellButtons = Markup.inlineKeyboard([
        [Markup.button.callback('Sell 25%', 'sell_25'), Markup.button.callback('Sell 50%', 'sell_50')],
        [Markup.button.callback('Sell 75%', 'sell_75'), Markup.button.callback('Sell 100%', 'sell_100')],
        [Markup.button.callback('Sell X%', 'sell_x')],
        [Markup.button.callback('❌ Close', 'close_profile')]
    ]);
    await ctx.reply(
        `💸 *Sell ${tokenData.symbol}*\nYou have: ${holding.amount.toFixed(2)} tokens\nPrice: $${tokenData.priceUsd.toFixed(8)}\n\nChoose how much to sell:`,
        { parse_mode: 'Markdown', ...sellButtons }
    );
});

for (const percent of [25, 50, 75, 100]) {
    bot.action(`sell_${percent}`, async (ctx) => {
        const userId = String(ctx.from.id);
        const actionData = pendingActions[userId];
        if (!actionData || actionData.action !== 'sell_x') return ctx.answerCbQuery('No pending sell action');
        await ctx.answerCbQuery();
        const { mint, tokenData, messageId } = actionData;
        delete pendingActions[userId];
        const result = await paperSell(userId, mint, tokenData, percent);
        if (!result.success) return ctx.reply(`❌ ${result.error}`);
        const sign = result.profitUsd >= 0 ? '+' : '';
        await ctx.reply(
            `${result.profitUsd >= 0 ? '🟢' : '🔴'} *SELL ${percent}% EXECUTED*\n─────────────────\n💰 Invested:   *$${result.investedAmount?.toFixed(2) || 'N/A'}*\n📊 Entry MCap: *$${result.entryMcap?.toLocaleString() || 'N/A'}*\n📊 Exit MCap:  *$${tokenData.marketCap.toLocaleString()}*\n${result.profitUsd >= 0 ? '🟢' : '🔴'} P&L:       *${sign}$${result.profitUsd.toFixed(2)} (${sign}${result.profitPercent.toFixed(2)}%)*\n💸 Fee:        *$${result.fee.toFixed(2)}* _(1%)_\n🏦 Balance:    *$${result.remainingUsd.toFixed(2)}*\n─────────────────\n🎮 _Demo Trade by Supryme_`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]) }
        );
        const fresh = await getTokenData(mint);
        if (fresh) await updateTokenCard(ctx, fresh, userId, messageId);
    });
}

bot.action('sell_x', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('💸 Send the percentage you want to sell (e.g. 30 for 30%):', Markup.inlineKeyboard([Markup.button.callback('❌ Close', 'close_profile')]));
});

bot.action('delete_card', async (ctx) => {
    const userId = String(ctx.from.id);
    const messageId = ctx.callbackQuery.message.message_id;
    await ctx.answerCbQuery('Deleted');
    await ctx.deleteMessage().catch(() => {});
    const cards = userCards.get(userId);
    if (cards) cards.delete(messageId);
});

bot.action('refresh', async (ctx) => {
    const userId = String(ctx.from.id);
    const messageId = ctx.callbackQuery.message.message_id;
    const cards = userCards.get(userId);
    const mint = cards?.get(messageId);
    if (!mint) return ctx.answerCbQuery('No token selected.');
    await ctx.answerCbQuery('🔄 Refreshing...');
    const freshData = await getTokenData(mint);
    if (!freshData) return ctx.answerCbQuery('❌ Failed to fetch price');
    await updateTokenCard(ctx, freshData, userId, messageId);
});

bot.launch();
console.log('🤖 Bot is running with JSON storage!');
