const API_BASE = 'https://app.timelines.ai/integrations/api';

async function timelinesGet(endpoint, params = {}) {
  const url = new URL(API_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': 'Bearer ' + process.env.TIMELINES_API_KEY,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('TimelinesAI error (' + res.status + '): ' + err);
  }

  return res.json();
}

async function fetchAllChats(accountFilter, maxPages) {
  var allChats = [];
  var page = 1;
  var max = maxPages || 10;

  while (page <= max) {
    var params = { page: page };
    if (accountFilter) params.whatsapp_account_id = accountFilter;

    var result = await timelinesGet('/chats', params);
    var chats = result.data && result.data.chats ? result.data.chats : [];
    if (chats.length === 0) break;
    allChats = allChats.concat(chats);
    if (chats.length < 50) break; // Last page
    page++;
  }

  return allChats;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var action = req.query.action || 'overview';

  try {
    // OVERVIEW — KPIs + accounts
    if (action === 'overview') {
      var accountsRes = await timelinesGet('/whatsapp_accounts');
      var accounts = accountsRes.data && accountsRes.data.whatsapp_accounts
        ? accountsRes.data.whatsapp_accounts : [];

      // Fetch chats (first 5 pages = 250 chats)
      var allChats = await fetchAllChats(null, 5);

      var totalChats = allChats.length;
      var unread = allChats.filter(function(c) { return !c.read; }).length;
      var activeAccounts = accounts.filter(function(a) { return a.status === 'active'; }).length;

      // Group by account
      var byAccount = {};
      accounts.forEach(function(a) {
        byAccount[a.id] = { name: a.account_name, phone: a.phone, status: a.status, chats: 0, unread: 0 };
      });
      allChats.forEach(function(c) {
        var aid = c.whatsapp_account_id;
        if (byAccount[aid]) {
          byAccount[aid].chats++;
          if (!c.read) byAccount[aid].unread++;
        }
      });

      return res.status(200).json({
        accounts: accounts,
        accountStats: byAccount,
        kpis: {
          total_chats: totalChats,
          unread: unread,
          active_accounts: activeAccounts,
          total_accounts: accounts.length,
        },
        chats_sample: allChats.length,
      });
    }

    // CHATS — paginated chat list
    if (action === 'chats') {
      var page = parseInt(req.query.page) || 1;
      var account = req.query.account || null;
      var readFilter = req.query.read;
      var params = { page: page };
      if (account) params.whatsapp_account_id = account;
      if (readFilter === 'true') params.read = true;
      if (readFilter === 'false') params.read = false;
      if (req.query.name) params.name = req.query.name;

      var result = await timelinesGet('/chats', params);
      return res.status(200).json(result);
    }

    // UNANSWERED — chats needing response
    if (action === 'unanswered') {
      var account = req.query.account || null;
      var allChats = await fetchAllChats(account, 10);

      // Filter: unread chats with a last message
      var unanswered = allChats.filter(function(c) {
        return !c.read && c.last_message_timestamp;
      });

      // Sort by oldest first (most urgent)
      unanswered.sort(function(a, b) {
        return (a.last_message_timestamp || '').localeCompare(b.last_message_timestamp || '');
      });

      // Calculate wait time
      var now = Date.now();
      unanswered = unanswered.map(function(c) {
        var lastMsg = c.last_message_timestamp ? new Date(c.last_message_timestamp).getTime() : now;
        var waitMs = now - lastMsg;
        var waitHours = Math.round(waitMs / 3600000 * 10) / 10;
        return {
          id: c.id,
          name: c.name || '',
          phone: c.phone || '',
          last_message_timestamp: c.last_message_timestamp,
          wait_hours: waitHours,
          whatsapp_account_id: c.whatsapp_account_id,
          responsible_name: c.responsible_name || '',
          labels: c.labels || [],
          chat_url: c.chat_url || '',
        };
      });

      return res.status(200).json({
        unanswered: unanswered,
        total: unanswered.length,
      });
    }

    // MESSAGES — get messages for a specific chat
    if (action === 'messages') {
      var chatId = req.query.chat_id;
      if (!chatId) return res.status(400).json({ error: 'chat_id required' });

      var params = {};
      if (req.query.after) params.after = req.query.after;
      if (req.query.before) params.before = req.query.before;

      var result = await timelinesGet('/chats/' + chatId + '/messages', params);
      return res.status(200).json(result);
    }

    // ACCOUNTS — just the WhatsApp accounts
    if (action === 'accounts') {
      var result = await timelinesGet('/whatsapp_accounts');
      return res.status(200).json(result);
    }

    // ANALYTICS — full analysis from recent messages
    if (action === 'analytics') {
      var accountId = req.query.account || '14073854144@s.whatsapp.net';
      var startPage = parseInt(req.query.start_page) || 9;
      var numPages = parseInt(req.query.pages) || 5;

      // Fetch chats with messages
      var chats = [];
      for (var p = startPage; p < startPage + numPages; p++) {
        try {
          var data = await timelinesGet('/chats', { whatsapp_account_id: accountId, page: p });
          var pageChats = data.data && data.data.chats ? data.data.chats : [];
          var recent = pageChats.filter(function(c) { return c.last_message_timestamp && c.last_message_timestamp >= '2026-02-07'; });
          chats = chats.concat(recent);
          if (pageChats.length < 50) break;
        } catch (e) { break; }
      }

      // Fetch messages from up to 25 chats
      var allMessages = [];
      var chatNames = {};
      for (var i = 0; i < Math.min(chats.length, 25); i++) {
        var c = chats[i];
        chatNames[c.id] = c.name || c.phone || '';
        try {
          var msgData = await timelinesGet('/chats/' + c.id + '/messages');
          var msgs = msgData.data && msgData.data.messages ? msgData.data.messages : [];
          msgs.forEach(function(m) {
            if (m.timestamp && m.timestamp >= '2026-02-07') {
              allMessages.push({
                text: (m.text || '').trim(),
                timestamp: m.timestamp,
                from_me: m.from_me,
                chat_id: c.id,
                chat_name: chatNames[c.id],
                account: accountId,
              });
            }
          });
        } catch (e) { /* skip */ }
      }

      // === Compute analytics ===
      var PT_WORDS = ['obrigad','voce','você','como','para','está','pode','preciso','tenho','meu','minha','bom dia','boa tarde','por favor','quando','aqui','sim','não','nao','oi','olá','tudo bem'];
      var EN_WORDS = ['thank','please','could','would','have','about','with','this','that','what','when','where','good morning','hello','yes','sure'];
      var POS_WORDS = ['obrigad','thank','agradec','excelente','otimo','ótimo','perfeito','maravilhos','parabens','parabéns','amei','adorei','incrivel','incrível','muito bom','wonderful','great','amazing','perfect','awesome','feliz','satisfeito','recomendo','sensacional'];
      var NEG_WORDS = ['reclamação','insatisf','reclam','péssim','pessim','horrivel','horrível','demora','demorado','ruim','pior','absurdo','vergonha','descaso','incompetent','frustrad','raiva','angry','terrible','horrible','worst','disappointed','complaint','ridiculo'];
      var CONV_WORDS = ['consulta','agendar','marcar reunião','quanto custa','contratar','preciso de advogado','need a lawyer','consultation','how much','price','interessad','agendar'];
      var TOPIC_MAP = {
        'Scheduling': ['consulta','agendar','marcar','reunião','reuniao','horário','meeting','appointment','schedule','disponib'],
        'Documents': ['document','documento','enviar','certidão','certidao','passaporte','passport','formulário','assinar','contrato'],
        'Payment': ['pagamento','pagar','boleto','invoice','fatura','cobranc','valor','quanto custa','honorar','payment','fee'],
        'Case Status': ['status','andamento','processo','caso','update','atualiz','novidad','resultado','aprovad','negad'],
        'Immigration': ['visto','visa','green card','eb-','i-130','i-140','i-485','uscis','imigra','petition','ajuste'],
        'Greetings': ['bom dia','boa tarde','boa noite','good morning','hello','oi','olá','tudo bem'],
      };

      // Volume by hour and day
      var byHour = {}; var byDow = {}; var byDate = {};
      var fromClient = 0; var fromFirm = 0;
      var dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

      allMessages.forEach(function(m) {
        if (m.from_me) fromFirm++; else fromClient++;
        try {
          var d = new Date(m.timestamp);
          var h = d.getHours();
          var dow = d.getDay();
          var ds = m.timestamp.substring(0, 10);
          byHour[h] = (byHour[h] || 0) + 1;
          byDow[dow] = (byDow[dow] || 0) + 1;
          byDate[ds] = (byDate[ds] || 0) + 1;
        } catch (e) {}
      });

      // Peak hour/day
      var peakHour = 0, peakHourCount = 0;
      Object.keys(byHour).forEach(function(h) { if (byHour[h] > peakHourCount) { peakHour = parseInt(h); peakHourCount = byHour[h]; } });
      var peakDow = 0, peakDowCount = 0;
      Object.keys(byDow).forEach(function(d) { if (byDow[d] > peakDowCount) { peakDow = parseInt(d); peakDowCount = byDow[d]; } });

      // Response times
      var chatMsgs = {};
      allMessages.forEach(function(m) {
        if (!chatMsgs[m.chat_id]) chatMsgs[m.chat_id] = [];
        chatMsgs[m.chat_id].push(m);
      });

      var responseTimes = [];
      Object.keys(chatMsgs).forEach(function(cid) {
        var msgs = chatMsgs[cid].sort(function(a, b) { return a.timestamp.localeCompare(b.timestamp); });
        for (var i = 0; i < msgs.length - 1; i++) {
          if (!msgs[i].from_me && msgs[i + 1].from_me) {
            try {
              var t1 = new Date(msgs[i].timestamp).getTime();
              var t2 = new Date(msgs[i + 1].timestamp).getTime();
              var diff = (t2 - t1) / 60000;
              if (diff > 0 && diff < 1440) responseTimes.push(diff);
            } catch (e) {}
          }
        }
      });

      responseTimes.sort(function(a, b) { return a - b; });
      var avgRT = responseTimes.length > 0 ? responseTimes.reduce(function(s, v) { return s + v; }, 0) / responseTimes.length : 0;
      var medRT = responseTimes.length > 0 ? responseTimes[Math.floor(responseTimes.length / 2)] : 0;
      var u5 = responseTimes.filter(function(r) { return r <= 5; }).length;
      var u30 = responseTimes.filter(function(r) { return r <= 30; }).length;
      var u60 = responseTimes.filter(function(r) { return r <= 60; }).length;
      var o4h = responseTimes.filter(function(r) { return r > 240; }).length;

      // Language
      var ptCount = 0, enCount = 0, mixedCount = 0;
      var textMsgs = allMessages.filter(function(m) { return m.text && m.text.length >= 3; });
      textMsgs.forEach(function(m) {
        var lo = m.text.toLowerCase();
        var hasPt = PT_WORDS.some(function(w) { return lo.indexOf(w) !== -1; });
        var hasEn = EN_WORDS.some(function(w) { return lo.indexOf(w) !== -1; });
        if (hasPt && !hasEn) ptCount++;
        else if (hasEn && !hasPt) enCount++;
        else if (hasPt && hasEn) mixedCount++;
      });

      // Sentiment
      var posCount = 0, negCount = 0, neuCount = 0;
      var posSamples = [], negSamples = [];
      textMsgs.forEach(function(m) {
        var lo = m.text.toLowerCase();
        var isPos = POS_WORDS.some(function(w) { return lo.indexOf(w) !== -1; });
        var isNeg = NEG_WORDS.some(function(w) { return lo.indexOf(w) !== -1; });
        if (isPos && !isNeg) { posCount++; if (posSamples.length < 5 && !m.from_me) posSamples.push({ text: m.text.substring(0, 100), time: m.timestamp.substring(0, 16), chat: m.chat_name }); }
        else if (isNeg) { negCount++; if (negSamples.length < 5) negSamples.push({ text: m.text.substring(0, 100), time: m.timestamp.substring(0, 16), chat: m.chat_name, from: m.from_me ? 'firm' : 'client' }); }
        else neuCount++;
      });

      // Topics
      var topicCounts = {};
      Object.keys(TOPIC_MAP).forEach(function(topic) {
        topicCounts[topic] = textMsgs.filter(function(m) {
          if (m.from_me) return false;
          var lo = m.text.toLowerCase();
          return TOPIC_MAP[topic].some(function(k) { return lo.indexOf(k) !== -1; });
        }).length;
      });

      // Conversion signals
      var conversions = textMsgs.filter(function(m) {
        if (m.from_me) return false;
        var lo = m.text.toLowerCase();
        return CONV_WORDS.some(function(w) { return lo.indexOf(w) !== -1; });
      }).slice(0, 10).map(function(m) {
        return { text: m.text.substring(0, 100), time: m.timestamp.substring(0, 16), chat: m.chat_name };
      });

      // Most active clients
      var clientCounts = {};
      allMessages.filter(function(m) { return !m.from_me; }).forEach(function(m) {
        clientCounts[m.chat_name] = (clientCounts[m.chat_name] || 0) + 1;
      });
      var topClients = Object.entries(clientCounts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10);

      // Ghost clients
      var ghosts = [];
      var unanswered24 = [];
      var now = Date.now();
      Object.keys(chatMsgs).forEach(function(cid) {
        var msgs = chatMsgs[cid].sort(function(a, b) { return a.timestamp.localeCompare(b.timestamp); });
        if (msgs.length === 0) return;
        var last = msgs[msgs.length - 1];
        try {
          var lastTime = new Date(last.timestamp).getTime();
          var hrsAgo = (now - lastTime) / 3600000;
          if (last.from_me && hrsAgo > 72) ghosts.push({ name: last.chat_name, days: Math.floor(hrsAgo / 24), ts: last.timestamp.substring(0, 10) });
          if (!last.from_me && hrsAgo > 24) unanswered24.push({ name: last.chat_name, hours: Math.floor(hrsAgo), ts: last.timestamp.substring(0, 16) });
        } catch (e) {}
      });
      ghosts.sort(function(a, b) { return b.days - a.days; });
      unanswered24.sort(function(a, b) { return b.hours - a.hours; });

      return res.status(200).json({
        volume: {
          total: allMessages.length,
          from_client: fromClient,
          from_firm: fromFirm,
          avg_per_day: Object.keys(byDate).length > 0 ? Math.round(allMessages.length / Object.keys(byDate).length * 10) / 10 : 0,
          active_days: Object.keys(byDate).length,
          peak_hour: peakHour,
          peak_hour_count: peakHourCount,
          peak_day: dowNames[peakDow],
          peak_day_count: peakDowCount,
          by_hour: byHour,
          by_dow: byDow,
        },
        response_time: {
          count: responseTimes.length,
          average_min: Math.round(avgRT),
          median_min: Math.round(medRT),
          fastest_min: responseTimes.length > 0 ? Math.round(responseTimes[0]) : 0,
          slowest_min: responseTimes.length > 0 ? Math.round(responseTimes[responseTimes.length - 1]) : 0,
          under_5min: u5,
          under_30min: u30,
          under_1hr: u60,
          over_4hr: o4h,
          pct_under_5: responseTimes.length > 0 ? Math.round(u5 / responseTimes.length * 100) : 0,
          pct_under_30: responseTimes.length > 0 ? Math.round(u30 / responseTimes.length * 100) : 0,
        },
        language: { portuguese: ptCount, english: enCount, mixed: mixedCount },
        sentiment: { positive: posCount, neutral: neuCount, negative: negCount, positive_samples: posSamples, negative_samples: negSamples },
        topics: topicCounts,
        conversions: conversions,
        clients: { top: topClients, ghosts: ghosts.slice(0, 10), unanswered_24h: unanswered24.slice(0, 10) },
        meta: { chats_sampled: Math.min(chats.length, 25), messages_analyzed: allMessages.length },
      });
    }

    return res.status(400).json({ error: 'Unknown action. Use: overview, chats, unanswered, messages, accounts, analytics' });
  } catch (err) {
    console.error('WhatsApp API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
