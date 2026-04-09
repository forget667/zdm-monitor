// api/zdm.js
const got = require('got');
const { Redis } = require('@upstash/redis');

// ============== 配置区域 ==============
// 从环境变量读取配置
const PUSH_PLUS_TOKEN = process.env.PUSH_PLUS_TOKEN || '';
const PUSH_PLUS_USER = process.env.PUSH_PLUS_USER || ''; // 可选，群组编码

// 初始化 Redis
const redis = Redis.fromEnv();

// 线报酷值得买配置
const DOMIN = 'http://news.ixbk.net';
const NEW_URL = DOMIN + '/plus/json/push_19.json';

// ============== 值得买筛选规则 ==============
// 规则说明：
// Status: 1=启用, 0=禁用
// title_gjc: 标题必须包含的关键词（用|分隔）
// title_pbc: 标题屏蔽关键词（用|分隔）
// Miprice: 最低价格
// Mxprice: 最高价格

const zdm_config = {
    "rule1": {
        "Status": 1,
        "title_gjc": "希捷|酷玩|Crucial|铠侠|臭宝|李子柒|好欢螺|川南|老干妈|轻酪乳|K90|水卫士|电子相框|优能肌活|碎冰冰|碎碎冰",
        "title_pbc": "轮胎|舒客|猫人|心相印|肖战",
        "Miprice": "",
        "Mxprice": ""
    }
};

// ============== 工具函数 ==============
function add0(m) {
    return m < 10 ? '0' + m : m;
}

function tuisong_replace(text, shuju) {
    if (shuju.category_name) { shuju.catename = shuju.category_name; }
    if (shuju.posttime) {
        let posttime = new Date(shuju.posttime * 1000);
        shuju.datetime = `${posttime.getFullYear()}-${add0(posttime.getMonth() + 1)}-${add0(posttime.getDate())}`;
        shuju.shorttime = `${posttime.getHours()}:${add0(posttime.getMinutes())}`;
    }
    
    const replacements = {
        '{标题}': shuju.title || '',
        '{内容}': shuju.content || '',
        '{分类名}': shuju.catename || '',
        '{链接}': shuju.url || '',
        '{日期}': shuju.datetime || '',
        '{时间}': shuju.shorttime || '',
        '{类目}': shuju.category_name || '',
        '{价格}': shuju.price || '',
        '{商城}': shuju.mall_name || '',
        '{品牌}': shuju.brand || '',
        '{图片}': shuju.pic || ''
    };
    
    for (const [key, value] of Object.entries(replacements)) {
        if (value !== undefined && value !== null) {
            text = text.replace(new RegExp(key, 'g'), value);
        } else {
            text = text.replace(new RegExp(key, 'g'), '');
        }
    }
    return text;
}

// 筛选函数
function zdm_listfilter(group, zdm_config) {
    const zdm_arr = Object.values(zdm_config);
    
    for (const item of zdm_arr) {
        if (item.Status !== 1) continue;
        if (group.type !== "smzdm") continue;
        
        // 商城筛选
        if (item.mall_name && group.mall_name && !new RegExp(item.mall_name, 'i').test(group.mall_name)) {
            continue;
        }
        
        // 价格区间筛选
        if ((item.Miprice !== "" && group.price !== "" && Number(group.price) < Number(item.Miprice)) ||
            (item.Mxprice !== "" && group.price !== "" && Number(group.price) > Number(item.Mxprice))) {
            continue;
        }
        
        // 标题筛选
        if (group.title && zdm_checkMatches(item.title_gjc, item.title_pbc, group.title)) {
            continue;
        }
        
        // 品牌筛选
        if (group.brand && zdm_checkMatches(item.brand_gjc, item.brand_pbc, group.brand)) {
            continue;
        }
        
        // 分类筛选
        if (group.category_name && zdm_checkMatches(item.category_gjc, item.category_pbc, group.category_name)) {
            continue;
        }
        
        return true;
    }
    return false;
}

function zdm_checkMatches(item_gjc, item_pbc, groupValue) {
    const gjcMatches = item_gjc && new RegExp(item_gjc, 'i').test(groupValue);
    const pbcMatches = item_pbc && new RegExp(item_pbc, 'i').test(groupValue);
    
    if (gjcMatches && pbcMatches) return true;
    if (item_gjc && !gjcMatches) return true;
    if (item_pbc && pbcMatches) return true;
    return false;
}

// ============== PushPlus 推送函数 ==============
async function pushPlusNotify(title, content) {
    if (!PUSH_PLUS_TOKEN) {
        console.log('⚠️ 未配置 PUSH_PLUS_TOKEN');
        return false;
    }

    try {
        // 将换行符转换为 HTML 的 <br>
        const htmlContent = content.replace(/\n/g, '<br>');
        
        const requestBody = {
            token: PUSH_PLUS_TOKEN,
            title: title,
            content: htmlContent
        };
        
        // 如果有群组编码，添加 topic 参数
        if (PUSH_PLUS_USER) {
            requestBody.topic = PUSH_PLUS_USER;
        }
        
        const response = await got.post('https://www.pushplus.plus/send', {
            json: requestBody,
            timeout: 10000
        });
        
        const result = JSON.parse(response.body);
        
        if (result.code === 200) {
            console.log(`✅ PushPlus 推送成功: ${title.substring(0, 50)}...`);
            return true;
        } else {
            console.log(`❌ PushPlus 推送失败: ${result.msg}`);
            return false;
        }
    } catch (error) {
        console.error('❌ PushPlus 推送错误:', error.message);
        return false;
    }
}

// ============== Redis 存储函数 ==============
const REDIS_KEY = 'zdm_sent_ids';
const REDIS_MAX_SIZE = 2000;

async function isMessageSent(id) {
    try {
        const exists = await redis.sismember(REDIS_KEY, id.toString());
        return exists === 1;
    } catch (error) {
        console.error('Redis 读取错误:', error.message);
        return false;
    }
}

async function saveSentId(id) {
    try {
        await redis.sadd(REDIS_KEY, id.toString());
        const size = await redis.scard(REDIS_KEY);
        if (size > REDIS_MAX_SIZE) {
            const allIds = await redis.smembers(REDIS_KEY);
            const toRemove = allIds.slice(0, size - REDIS_MAX_SIZE);
            if (toRemove.length > 0) {
                await redis.srem(REDIS_KEY, ...toRemove);
            }
        }
        console.log(`💾 已记录 ID: ${id}`);
    } catch (error) {
        console.error('Redis 保存错误:', error.message);
    }
}

// ============== 主函数 ==============
module.exports = async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 开始获取线报酷值得买数据...');
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        if (!PUSH_PLUS_TOKEN) {
            throw new Error('未配置 PUSH_PLUS_TOKEN，请在 Vercel 环境变量中设置');
        }
        
        console.log('📡 请求值得买 API...');
        const response = await got.get(NEW_URL, {
            timeout: 30000,
            retry: { limit: 2 }
        });
        
        const xbkdata = JSON.parse(response.body);
        console.log(`📊 获取到 ${xbkdata.length} 条数据`);
        
        // 筛选新数据
        let newItems = [];
        let filteredCount = 0;
        
        for (const item of xbkdata) {
            const alreadySent = await isMessageSent(item.id);
            
            if (!alreadySent) {
                await saveSentId(item.id);
                
                if (zdm_listfilter(item, zdm_config)) {
                    newItems.push(item);
                } else {
                    filteredCount++;
                }
            }
        }
        
        console.log(`📋 新数据 ${newItems.length} 条，被筛选过滤 ${filteredCount} 条`);
        
        // ============== 主函数中的推送部分 ==============
        let pushSuccess = 0;
        let pushFailed = 0;

        for (const item of newItems) {
            // 修复链接：只有相对路径才添加域名
            if (item.url && !item.url.startsWith('http')) {
            item.url = DOMIN + item.url;
            }
    
    const title = tuisong_replace("【{价格}元】{标题}", item);
    
    // 使用 HTML 格式，链接可点击
    const content = tuisong_replace(`
📦 分类：{类目}
💰 到手价：{价格}元
🏪 购买平台：{商城}
🏷️ 品牌：{品牌}
<img src="{图片}" style="max-width:100%; border-radius:8px;" referrerpolicy="no-referrer">
<a href="{链接}" target="_blank" style="background-color:#07c; color:white; padding:8px 16px; text-decoration:none; border-radius:5px;">打开商品链接（点击跳转值得买原文购买）</a>
🌟来自cron-job.org定时任务 Github Forget667
🌟由Vercel部署 Upstash提供可持续化存储`, item);
    
    const success = await pushPlusNotify(title, content);
    if (success) {
        pushSuccess++;
    } else {
        pushFailed++;
    }
    
    console.log(`📢 推送: ${item.title.substring(0, 50)}...`);
    await new Promise(r => setTimeout(r, 500));
}

        
        const duration = Date.now() - startTime;
        console.log(`✅ 执行完成，耗时 ${duration}ms，成功 ${pushSuccess} 条，失败 ${pushFailed} 条`);
        
        res.status(200).json({
            success: true,
            timestamp: new Date().toISOString(),
            total: xbkdata.length,
            newItems: newItems.length,
            filteredCount: filteredCount,
            pushSuccess: pushSuccess,
            pushFailed: pushFailed,
            duration: duration,
            message: `发现 ${newItems.length} 条新值得买，推送成功 ${pushSuccess} 条`
        });
        
    } catch (error) {
        console.error('❌ 执行出错:', error.message);
        if (error.response) {
            console.error('状态码:', error.response.statusCode);
        }
        
        res.status(500).json({
            success: false,
            timestamp: new Date().toISOString(),
            error: error.message,
            type: error.name
        });
    }
};
