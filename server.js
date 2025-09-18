const Fastify = require("fastify");
const cors = require("@fastify/cors");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ================== CONFIG ==================
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJxZ2FtZWVwbGF5IiwiYm90IjowLCJpc01lcmNoYW50IjpmYWxzZSwidmVyaWZpZWRCYW5rQWNjb3VudCI6dHJ1ZSwicGxheUV2ZW50TG9iYnkiOmZhbHNlLCJjdXN0b21lcklkIjoyMDQzODEzMzAsImFmZklkIjoiU3Vud2luIiwiYmFubmVkIjpmYWxzZSwiYnJhbmQiOiJzdW4ud2luIiwidGltZXN0YW1wIjoxNzU4MjA0ODc0NTYxLCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjI0MDE6ZDgwMDpiNDkwOmVkMjc6MWRhMTo0NDFmOjYzYmQ6YzM5YiIsIm11dGUiOmZhbHNlLCJhdmF0YXIiOiJodHRwczovL2ltYWdlcy5zd2luc2hvcC5uZXQvaW1hZ2VzL2F2YXRhci9hdmF0YXJfMDYucG5nIiwicGxhdGZvcm1JZCI6NSwidXNlcklkIjoiODcyMGM1YTctNDU4MS00YmNmLTk5ZmItZGU5MjQ5ZWU5NDkyIiwicmVnVGltZSI6MTczNzY1MDg4ODc1MiwicGhvbmUiOiIiLCJkZXBvc2l0Ijp0cnVlLCJ1c2VybmFtZSI6IlNDX3FxYWFzc2RkIn0.ZdUhTxLYxtvd3mjxPIyymCaj9AFgVYpHbCfVElULSFE";

const fastify = Fastify({ logger: false });
const PORT = process.env.PORT || 3001;
const HISTORY_FILE = path.join(__dirname, 'taixiu_history.json');

let rikResults = [];
let rikCurrentSession = null;
let rikWS = null;
let rikIntervalCmd = null;
let modelPredictions = {};

// ================== LỊCH SỬ ==================
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            rikResults = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            console.log(`📚 Loaded ${rikResults.length} history records`);
        }
    } catch (err) {
        console.error('Error loading history:', err);
    }
}

function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(rikResults), 'utf8');
    } catch (err) {
        console.error('Error saving history:', err);
    }
}

// ================== XỬ LÝ KẾT QUẢ ==================
function decodeBinaryMessage(buffer) {
    try {
        const str = buffer.toString();
        if (str.startsWith("[")) return JSON.parse(str);
        let position = 0, result = [];
        while (position < buffer.length) {
            const type = buffer.readUInt8(position++);
            if (type === 1) {
                const len = buffer.readUInt16BE(position); position += 2;
                result.push(buffer.toString('utf8', position, position + len));
                position += len;
            } else if (type === 2) {
                result.push(buffer.readInt32BE(position)); position += 4;
            } else if (type === 3 || type === 4) {
                const len = buffer.readUInt16BE(position); position += 2;
                result.push(JSON.parse(buffer.toString('utf8', position, position + len)));
                position += len;
            } else {
                console.warn("Unknown binary type:", type); break;
            }
        }
        return result.length === 1 ? result[0] : result;
    } catch (e) {
        console.error("Binary decode error:", e);
        return null;
    }
}

function getTX(d1, d2, d3) {
    return d1 + d2 + d3 >= 11 ? "Tài" : "Xỉu";
}

// ================== THUẬT TOÁN DỰ ĐOÁN NÂNG CAO MỚI ==================
function detectStreakAndBreak(history) {
    if (!history || history.length === 0) return { streak: 0, currentResult: null, breakProb: 0.0 };
    let streak = 1;
    const currentResult = history[history.length - 1].result;
    for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].result === currentResult) {
            streak++;
        } else {
            break;
        }
    }
    const last15 = history.slice(-15).map(h => h.result);
    if (!last15.length) return { streak, currentResult, breakProb: 0.0 };
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr !== last15[idx] ? 1 : 0), 0);
    const taiCount = last15.filter(r => r === 'Tài').length;
    const xiuCount = last15.filter(r => r === 'Xỉu').length;
    const imbalance = Math.abs(taiCount - xiuCount) / last15.length;
    let breakProb = 0.0;
  
    if (streak >= 8) {
        breakProb = Math.min(0.6 + (switches / 15) + imbalance * 0.15, 0.9);
    } else if (streak >= 5) {
        breakProb = Math.min(0.35 + (switches / 10) + imbalance * 0.25, 0.85);
    } else if (streak >= 3 && switches >= 7) {
        breakProb = 0.3;
    }
  
    return { streak, currentResult, breakProb };
}
  
function evaluateModelPerformance(history, modelName, lookback = 10) {
    if (!modelPredictions[modelName] || history.length < 2) return 1.0;
    lookback = Math.min(lookback, history.length - 1);
    let correctCount = 0;
    for (let i = 0; i < lookback; i++) {
        const pred = modelPredictions[modelName][history[history.length - (i + 2)].session] || 0;
        const actual = history[history.length - (i + 1)].result;
        if ((pred === 1 && actual === 'Tài') || (pred === 2 && actual === 'Xỉu')) {
            correctCount++;
        }
    }
    const performanceScore = lookback > 0 ? 1.0 + (correctCount - lookback / 2) / (lookback / 2) : 1.0;
    return Math.max(0.5, Math.min(1.5, performanceScore));
}
  
function smartBridgeBreak(history) {
    if (!history || history.length < 3) return { prediction: 0, breakProb: 0.0, reason: 'Không đủ dữ liệu để bẻ cầu' };
  
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    const last20 = history.slice(-20);
    const lastScores = last20.map(h => h.total);
    const last20Results = last20.map(h => h.result);
    let breakProbability = breakProb;
    let reason = '';
  
    const avgScore = lastScores.reduce((sum, score) => sum + score, 0) / (lastScores.length || 1);
    const scoreDeviation = lastScores.reduce((sum, score) => sum + Math.abs(score - avgScore), 0) / (lastScores.length || 1);
  
    const patternCounts = {};
    for (let i = 0; i <= last20Results.length - 3; i++) {
        const pattern = last20Results.slice(i, i + 3).join(',');
        patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
    }
    const mostCommonPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    const isStablePattern = mostCommonPattern && mostCommonPattern[1] >= 3;
  
    if (streak >= 6) {
        breakProbability = Math.min(breakProbability + 0.15, 0.9);
        reason = `[Bẻ Cầu] Chuỗi ${streak} ${currentResult} dài, khả năng bẻ cầu cao`;
    } else if (streak >= 4 && scoreDeviation > 3) {
        breakProbability = Math.min(breakProbability + 0.1, 0.85);
        reason = `[Bẻ Cầu] Biến động điểm số lớn (${scoreDeviation.toFixed(1)}), khả năng bẻ cầu tăng`;
    } else if (isStablePattern && last20Results.slice(-5).every(r => r === currentResult)) {
        breakProbability = Math.min(breakProbability + 0.05, 0.8);
        reason = `[Bẻ Cầu] Phát hiện mẫu lặp ${mostCommonPattern[0]}, có khả năng bẻ cầu`;
    } else {
        breakProbability = Math.max(breakProbability - 0.15, 0.15);
        reason = `[Bẻ Cầu] Không phát hiện mẫu bẻ cầu mạnh, tiếp tục theo cầu`;
    }
  
    let prediction = breakProbability > 0.65 ? (currentResult === 'Tài' ? 2 : 1) : (currentResult === 'Tài' ? 1 : 2);
    return { prediction, breakProb: breakProbability, reason };
}
  
function trendAndProb(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 5) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 2 : 1;
        }
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last15 = history.slice(-15).map(h => h.result);
    if (!last15.length) return 0;
    const weights = last15.map((_, i) => Math.pow(1.2, i));
    const taiWeighted = weights.reduce((sum, w, i) => sum + (last15[i] === 'Tài' ? w : 0), 0);
    const xiuWeighted = weights.reduce((sum, w, i) => sum + (last15[i] === 'Xỉu' ? w : 0), 0);
    const totalWeight = taiWeighted + xiuWeighted;
    const last10 = last15.slice(-10);
    const patterns = [];
    if (last10.length >= 4) {
        for (let i = 0; i <= last10.length - 4; i++) {
            patterns.push(last10.slice(i, i + 4).join(','));
        }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 3) {
        const pattern = mostCommon[0].split(',');
        return pattern[pattern.length - 1] !== last10[last10.length - 1] ? 1 : 2;
    } else if (totalWeight > 0 && Math.abs(taiWeighted - xiuWeighted) / totalWeight >= 0.25) {
        return taiWeighted > xiuWeighted ? 2 : 1;
    }
    return last15[last15.length - 1] === 'Xỉu' ? 1 : 2;
}
  
function shortPattern(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 2 : 1;
        }
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last8 = history.slice(-8).map(h => h.result);
    if (!last8.length) return 0;
    const patterns = [];
    if (last8.length >= 3) {
        for (let i = 0; i <= last8.length - 3; i++) {
            patterns.push(last8.slice(i, i + 3).join(','));
        }
    }
    const patternCounts = patterns.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {});
    const mostCommon = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
    if (mostCommon && mostCommon[1] >= 2) {
        const pattern = mostCommon[0].split(',');
        return pattern[pattern.length - 1] !== last8[last8.length - 1] ? 1 : 2;
    }
    return last8[last8.length - 1] === 'Xỉu' ? 1 : 2;
}
  
function meanDeviation(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 2 : 1;
        }
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last12 = history.slice(-12).map(h => h.result);
    if (!last12.length) return 0;
    const taiCount = last12.filter(r => r === 'Tài').length;
    const xiuCount = last12.length - taiCount;
    const deviation = Math.abs(taiCount - xiuCount) / last12.length;
    if (deviation < 0.35) {
        return last12[last12.length - 1] === 'Xỉu' ? 1 : 2;
    }
    return xiuCount > taiCount ? 1 : 2;
}
  
function recentSwitch(history) {
    if (!history || history.length < 3) return 0;
    const { streak, currentResult, breakProb } = detectStreakAndBreak(history);
    if (streak >= 4) {
        if (breakProb > 0.75) {
            return currentResult === 'Tài' ? 2 : 1;
        }
        return currentResult === 'Tài' ? 1 : 2;
    }
    const last10 = history.slice(-10).map(h => h.result);
    if (!last10.length) return 0;
    const switches = last10.slice(1).reduce((count, curr, idx) => count + (curr !== last10[idx] ? 1 : 0), 0);
    return switches >= 6 ? (last10[last10.length - 1] === 'Xỉu' ? 1 : 2) : (last10[last10.length - 1] === 'Xỉu' ? 1 : 2);
}
  
function isBadPattern(history) {
    if (!history || history.length < 3) return false;
    const last15 = history.slice(-15).map(h => h.result);
    if (!last15.length) return false;
    const switches = last15.slice(1).reduce((count, curr, idx) => count + (curr !== last15[idx] ? 1 : 0), 0);
    const { streak } = detectStreakAndBreak(history);
    return switches >= 9 || streak >= 10;
}
  
function aiHtddLogic(history) {
    if (!history || history.length < 3) {
        const randomResult = Math.random() < 0.5 ? 'Tài' : 'Xỉu';
        return { prediction: randomResult, reason: '[AI] Không đủ lịch sử, dự đoán ngẫu nhiên', source: 'AI HTDD' };
    }
    const recentHistory = history.slice(-5).map(h => h.result);
    const recentScores = history.slice(-5).map(h => h.total || 0);
    const taiCount = recentHistory.filter(r => r === 'Tài').length;
    const xiuCount = recentHistory.filter(r => r === 'Xỉu').length;
  
    if (history.length >= 3) {
        const last3 = history.slice(-3).map(h => h.result);
        if (last3.join(',') === 'Tài,Xỉu,Tài') {
            return { prediction: 'Xỉu', reason: '[AI] Phát hiện mẫu 1T1X → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
        } else if (last3.join(',') === 'Xỉu,Tài,Xỉu') {
            return { prediction: 'Tài', reason: '[AI] Phát hiện mẫu 1X1T → tiếp theo nên đánh Tài', source: 'AI HTDD' };
        }
    }
  
    if (history.length >= 4) {
        const last4 = history.slice(-4).map(h => h.result);
        if (last4.join(',') === 'Tài,Tài,Xỉu,Xỉu') {
            return { prediction: 'Tài', reason: '[AI] Phát hiện mẫu 2T2X → tiếp theo nên đánh Tài', source: 'AI HTDD' };
        } else if (last4.join(',') === 'Xỉu,Xỉu,Tài,Tài') {
            return { prediction: 'Xỉu', reason: '[AI] Phát hiện mẫu 2X2T → tiếp theo nên đánh Xỉu', source: 'AI HTDD' };
        }
    }
  
    if (history.length >= 9 && history.slice(-6).every(h => h.result === 'Tài')) {
        return { prediction: 'Xỉu', reason: '[AI] Chuỗi Tài quá dài (6 lần) → dự đoán Xỉu', source: 'AI HTDD' };
    } else if (history.length >= 9 && history.slice(-6).every(h => h.result === 'Xỉu')) {
        return { prediction: 'Tài', reason: '[AI] Chuỗi Xỉu quá dài (6 lần) → dự đoán Tài', source: 'AI HTDD' };
    }
  
    const avgScore = recentScores.reduce((sum, score) => sum + score, 0) / (recentScores.length || 1);
    if (avgScore > 10) {
        return { prediction: 'Tài', reason: `[AI] Điểm trung bình cao (${avgScore.toFixed(1)}) → dự đoán Tài`, source: 'AI HTDD' };
    } else if (avgScore < 8) {
        return { prediction: 'Xỉu', reason: `[AI] Điểm trung bình thấp (${avgScore.toFixed(1)}) → dự đoán Xỉu`, source: 'AI HTDD' };
    }
  
    if (taiCount > xiuCount + 1) {
        return { prediction: 'Xỉu', reason: `[AI] Tài chiếm đa số (${taiCount}/${recentHistory.length}) → dự đoán Xỉu`, source: 'AI HTDD' };
    } else if (xiuCount > taiCount + 1) {
        return { prediction: 'Tài', reason: `[AI] Xỉu chiếm đa số (${xiuCount}/${recentHistory.length}) → dự đoán Tài`, source: 'AI HTDD' };
    } else {
        const overallTai = history.filter(h => h.result === 'Tài').length;
        const overallXiu = history.filter(h => h.result === 'Xỉu').length;
        if (overallTai > overallXiu + 2) {
            return { prediction: 'Xỉu', reason: '[AI] Tổng thể Tài nhiều hơn → dự đoán Xỉu', source: 'AI HTDD' };
        } else if (overallXiu > overallTai + 2) {
            return { prediction: 'Tài', reason: '[AI] Tổng thể Xỉu nhiều hơn → dự đoán Tài', source: 'AI HTDD' };
        } else {
            return { prediction: Math.random() < 0.5 ? 'Tài' : 'Xỉu', reason: '[AI] Cân bằng, dự đoán ngẫu nhiên', source: 'AI HTDD' };
        }
    }
}

// ================== THUẬT TOÁN DỰ ĐOÁN MỚI XỊN HƠN ==================
         function advancedPredictionAlgorithm(history) {
    if (!history || history.length < 5) {
        // Không đủ dữ liệu -> mặc định theo kết quả gần nhất
        return { 
            prediction: history && history.length > 0 ? history[history.length - 1].result : 'Tài', 
            reason: 'Không đủ dữ liệu lịch sử, dự đoán theo kết quả gần nhất' 
        };
    }

    // Phân tích mẫu chuỗi
    const lastResults = history.slice(-10).map(h => h.result);
    const lastTotals = history.slice(-10).map(h => h.total);
    
    // Phân tích chuỗi liên tiếp
    let currentStreak = 1;
    let currentType = lastResults[lastResults.length - 1];
    for (let i = lastResults.length - 2; i >= 0; i--) {
        if (lastResults[i] === currentType) {
            currentStreak++;
        } else {
            break;
        }
    }
    
    // Phân tích điểm số
    const avgTotal = lastTotals.reduce((a, b) => a + b, 0) / lastTotals.length;
    const totalVariance = lastTotals.reduce((a, b) => a + Math.pow(b - avgTotal, 2), 0) / lastTotals.length;
    
    // Phân tích xu hướng
    const taiCount = lastResults.filter(r => r === 'Tài').length;
    const xiuCount = lastResults.length - taiCount;
    
    // Thuật toán dự đoán nâng cao
    let taiScore = 0;
    let xiuScore = 0;
    
    // 1. Phân tích chuỗi
    if (currentStreak >= 4) {
        // Chuỗi dài có xu hướng đảo chiều
        if (currentStreak >= 6) {
            currentType === 'Tài' ? xiuScore += 0.4 : taiScore += 0.4;
        } else if (currentStreak >= 4) {
            currentType === 'Tài' ? xiuScore += 0.25 : taiScore += 0.25;
        }
    }
    
    // 2. Phân tích điểm số
    if (avgTotal > 11) {
        // Điểm trung bình cao -> tiếp tục Tài
        taiScore += 0.2;
    } else if (avgTotal < 9) {
        // Điểm trung bình thấp -> tiếp tục Xỉu
        xiuScore += 0.2;
    }
    
    // 3. Phân tích biến động
    if (totalVariance > 8) {
        // Biến động cao -> khó dự đoán, giảm điểm
        taiScore *= 0.8;
        xiuScore *= 0.8;
    }
    
    // 4. Phân tích tỷ lệ gần đây
    if (taiCount > xiuCount * 1.5) {
        // Tài nhiều hơn đáng kể -> tăng khả năng Xỉu
        xiuScore += 0.15;
    } else if (xiuCount > taiCount * 1.5) {
        // Xỉu nhiều hơn đáng kể -> tăng khả năng Tài
        taiScore += 0.15;
    }
    
    // ⚠️ Bỏ hoàn toàn randomFactor
    
    // Tạo dự đoán
    let prediction, reason;
    if (taiScore > xiuScore + 0.1) {
        prediction = 'Tài';
        reason = `Dự đoán Tài (điểm: Tài ${taiScore.toFixed(2)} vs Xỉu ${xiuScore.toFixed(2)}) - Chuỗi ${currentType} ${currentStreak} lượt, điểm TB ${avgTotal.toFixed(1)}`;
    } else if (xiuScore > taiScore + 0.1) {
        prediction = 'Xỉu';
        reason = `Dự đoán Xỉu (điểm: Tài ${taiScore.toFixed(2)} vs Xỉu ${xiuScore.toFixed(2)}) - Chuỗi ${currentType} ${currentStreak} lượt, điểm TB ${avgTotal.toFixed(1)}`;
    } else {
        // Nếu hòa điểm -> chọn theo kết quả gần nhất
        prediction = currentType;
        reason = `Điểm cân bằng (Tài ${taiScore.toFixed(2)} vs Xỉu ${xiuScore.toFixed(2)}), chọn theo kết quả gần nhất: ${currentType}`;
    }
    
    return { prediction, reason };
}

function generatePrediction(history) {
    // Sử dụng thuật toán mới thay vì thuật toán cũ
    return advancedPredictionAlgorithm(history);
         }

// ================== WEBSOCKET ==================
const LOGIN_MESSAGE = [
    1,
    "MiniGame",
    "GM_binhlaanh",
    "ditmemay",
    {
        info: JSON.stringify({
            ipAddress: "125.235.238.0",
            wsToken: TOKEN,
            locale: "vi",
            userId: "6fe31b15-f6a5-4552-9b52-6f57fe689664",
            username: "GM_binhlaanh",
            timestamp: 1757830712545,
            refreshToken: "ee05dfbd01d0493485cbf93384a524a5.5552f091eaf1451cbc5a2db3aadf20f6",
            avatar: "https://images.swinshop.net/images/avatar/avatar_02.png",
            platformId: 2
        }),
        signature: "760DBA8B5E3BB3F1FD58A32299C320B2AB04C38EFDA970C4F1C3C7EC40368CDE3C9EBAEDB59A4DE76B2F39BA743AB69DF3F8110B3CCDA89D206B4A46B5681146D8527B3EA2F04065810BA41F1125015C1D2698072A7FC58298DDBD3E75048D59BF57E44CE08D5BDC550063075EF60A0FF63AF8B987571525A66F17F95D1AF0DE",
        pid: 5,
        subi: true
    }
];

const SUBSCRIBE_TX_RESULT = [6, "MiniGame", "taixiuPlugin", { cmd: 1005 }];
const SUBSCRIBE_LOBBY = [7, "Lobby", "lobby", 0, { id: 0 }];
const PING_MESSAGE = "2";

let lastEventId = 0;

function connectRikWebSocket() {
    console.log("🔌 Connecting to SunWin WebSocket...");
    rikWS = new WebSocket(`wss://websocket.gmwin.io/websocket?token=${TOKEN}`);

    rikWS.on("open", () => {
        console.log("✅ WebSocket connected");
        rikWS.send(JSON.stringify(LOGIN_MESSAGE));
        
        setTimeout(() => {
            rikWS.send(JSON.stringify(SUBSCRIBE_TX_RESULT));
            rikWS.send(JSON.stringify(SUBSCRIBE_LOBBY));
        }, 1000);

        clearInterval(rikIntervalCmd);
        rikIntervalCmd = setInterval(() => {
            if (rikWS?.readyState === WebSocket.OPEN) {
                rikWS.send(PING_MESSAGE);
                rikWS.send(JSON.stringify(SUBSCRIBE_TX_RESULT));
                rikWS.send(JSON.stringify([7, "Simms", lastEventId, 0, { id: 0 }]));
            }
        }, 15000);
    });

    // Thêm xử lý sự kiện pong
    rikWS.on('pong', () => console.log('[📶] Ping OK.'));

    rikWS.on("message", (data) => {
        try {
            const json = typeof data === 'string' ? JSON.parse(data) : decodeBinaryMessage(data);
            if (!json) return;

            if (Array.isArray(json) && json[0] === 7 && json[2] > lastEventId) {
                lastEventId = json[2];
            }

            // Xử lý tất cả dữ liệu từ một nguồn duy nhất
            if (Array.isArray(json) && json[3]?.res?.d1) {
                const res = json[3].res;
                if (!rikCurrentSession || res.sid > rikCurrentSession) {
                    rikCurrentSession = res.sid;
                    const result = getTX(res.d1, res.d2, res.d3);
                    rikResults.unshift({ 
                        sid: res.sid, 
                        d1: res.d1, 
                        d2: res.d2, 
                        d3: res.d3, 
                        total: res.d1+res.d2+res.d3, 
                        result, 
                        timestamp: Date.now() 
                    });
                    if (rikResults.length > 100) rikResults.pop();
                    saveHistory();
                    console.log(`📥 Phiên mới ${res.sid} → ${result}`);
                }
            } else if (Array.isArray(json) && json[1]?.htr) {
                rikResults = json[1].htr.map(i => ({
                    sid: i.sid, 
                    d1: i.d1, 
                    d2: i.d2, 
                    d3: i.d3, 
                    total: i.d1+i.d2+i.d3, 
                    result: getTX(i.d1, i.d2, i.d3), 
                    timestamp: Date.now()
                })).sort((a, b) => b.sid - a.sid).slice(0, 100);
                saveHistory();
                console.log("📦 Đã tải lịch sử các phiên gần nhất.");
            }
        } catch (e) {
            console.error("❌ Parse error:", e.message);
        }
    });

    rikWS.on("close", () => {
        console.log("🔌 WebSocket disconnected. Reconnecting...");
        setTimeout(connectRikWebSocket, 5000);
    });

    rikWS.on("error", (err) => {
        console.error("🔌 WebSocket error:", err.message);
        rikWS.close();
    });
}

// ================== API ==================
fastify.register(cors);

// API kết quả hiện tại
fastify.get("/api/taixiu/sunwin", async () => {
    const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
    if (!valid.length) return { message: "Không có dữ liệu." };

    const current = valid[0];
    const sum = current.d1 + current.d2 + current.d3;
    const ket_qua = sum >= 11 ? "Tài" : "Xỉu";
    
    // Sử dụng thuật toán mới để dự đoán
    const predictionResult = generatePrediction(valid.slice().reverse()); 

    const pattern = valid
        .slice(0, 15)
        .map(r => getTX(r.d1, r.d2, r.d3).toLowerCase())
        .join('');
    
    return {
        Phien: current.sid,
        Phien_hien_tai: current.sid + 1,
        Xuc_xac_1: current.d1,
        Xuc_xac_2: current.d2,
        Xuc_xac_3: current.d3,
        Tong: sum,
        Ket_qua: ket_qua,
        du_doan: predictionResult.prediction,
        Pattern: pattern,
        ghi_chu: predictionResult.reason,
        ty_le: {
            Tai: (pattern.split('t').length - 1) / pattern.length,
            Xiu: (pattern.split('x').length - 1) / pattern.length
        }
    };
});

// API lấy lịch sử
fastify.get("/api/taixiu/history", async () => {
    const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
    if (!valid.length) return { message: "Không có dữ liệu lịch sử." };
    return valid.map(i => ({
        session: i.sid,
        dice: [i.d1, i.d2, i.d3],
        total: i.d1 + i.d2 + i.d3,
        result: getTX(i.d1, i.d2, i.d3)
    }));
});

// API thống kê nâng cao
fastify.get("/api/taixiu/analysis", async () => {
    const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
    if (!valid.length) return { message: "Không có dữ liệu lịch sử." };
    
    const predictionResult = generatePrediction(valid.slice().reverse());
    
    const pattern = valid
        .map(r => getTX(r.d1, r.d2, r.d3).toLowerCase())
        .join('');
    
    const tCount = (pattern.match(/t/g) || []).length;
    const xCount = (pattern.match(/x/g) || []).length;
    
    let streaks = [];
    let currentStreak = 1;
    let currentChar = pattern[0];
    
    for (let i = 1; i < pattern.length; i++) {
        if (pattern[i] === currentChar) {
            currentStreak++;
        } else {
            streaks.push({ type: currentChar, length: currentStreak });
            currentChar = pattern[i];
            currentStreak = 1;
        }
    }
    streaks.push({ type: currentChar, length: currentStreak });
    
    const maxTStreak = Math.max(...streaks.filter(s => s.type === 't').map(s => s.length));
    const maxXStreak = Math.max(...streaks.filter(s => s.type === 'x').map(s => s.length));
    
    let transitions = { tt: 0, tx: 0, xt: 0, xx: 0 };
    for (let i = 0; i < pattern.length - 1; i++) {
        const transition = pattern[i] + pattern[i+1];
        transitions[transition]++;
    }
    
    return {
        total_sessions: valid.length,
        tai_count: tCount,
        xiu_count: xCount,
        tai_rate: tCount / valid.length,
        xiu_rate: xCount / valid.length,
        max_tai_streak: maxTStreak,
        max_xiu_streak: maxXStreak,
        transitions: transitions,
        prediction: predictionResult.prediction,
        prediction_reason: predictionResult.reason
    };
});

// ================== START SERVER ==================
const start = async () => {
    try {
        loadHistory();
        connectRikWebSocket();
        const address = await fastify.listen({ port: PORT, host: "0.0.0.0" });
        console.log(`🚀 API chạy tại ${address}`);
    } catch (err) {
        console.error("❌ Server error:", err);
        process.exit(1);
    }
};

start();





