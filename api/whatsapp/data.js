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

    return res.status(400).json({ error: 'Unknown action. Use: overview, chats, unanswered, messages, accounts' });
  } catch (err) {
    console.error('WhatsApp API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
