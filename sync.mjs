// QA Ops Console — data sync script
// Pulls live data from Jira, Confluence, and Slack and writes it into data.json
// so the static GitHub Pages site can render near-real-time information.
//
// Required GitHub Actions secrets (added by repo owner, never by an AI agent):
//   JIRA_EMAIL        - Atlassian account email
//   JIRA_API_TOKEN     - Atlassian API token (id.atlassian.com/manage-profile/security/api-tokens)
//   SLACK_BOT_TOKEN     - Slack bot token (xoxb-...) from a Slack app with scopes:
//                         channels:history, channels:read, channels:join, groups:history,
//                         groups:read, users:read
//                         Channels synced: 기술-로보틱스팀, 기술-휴가, 기술-qa팀, 기술조직,
//                         sigint, sigvise, and any 기술과제-* channel.
//                         Private channels (기술-qa팀, sigint, sigvise) can't be auto-joined —
//                         the bot must be invited manually (/invite @qa-ops-console-sync).
//                         The live feed only shows messages from #기술-qa팀 members (the QA
//                         team roster), so the bot must be in #기술-qa팀 for the feed to work.
//
// Any step that is missing its secret, or that errors, is skipped gracefully —
// the site keeps showing the last known value rather than breaking.

import fs from 'node:fs/promises';

const JIRA_SITE = 'https://dohands.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN || '';
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || '';

// Jira funnel now mirrors this saved filter directly instead of a fixed set of projects:
// https://dohands.atlassian.net/issues/?filter=10973
const FUNNEL_FILTER_ID = '10973';

// Calendar (release/incident) only surfaces Jira due-date items assigned to these three people.
const CALENDAR_ASSIGNEE_ACCOUNT_IDS = [
  '712020:a6a46ae3-9120-4389-9152-5870017801ec', // 베스현승
  '712020:7b28026d-6df8-4f5a-8a1d-b884a69702c0', // 최라온
  '712020:75dd4f22-4af3-4265-b213-381e3185e3fb', // 김태재
];

// Exact channel names to pull from, plus any channel starting with "기술과제-".
// #기술-리더 and every other 기술-/sig channel not listed here are intentionally excluded.
const SLACK_CHANNEL_NAMES = ['기술-로보틱스팀', '기술-휴가', '기술-qa팀', '기술조직', 'sigint', 'sigvise'];
const SLACK_CHANNEL_PREFIXES = ['기술과제-'];
const QA_TEAM_CHANNEL_NAME = '기술-qa팀'; // membership of this channel defines "QA team" for message filtering

function isTargetChannel(name) {
  return SLACK_CHANNEL_NAMES.includes(name) || SLACK_CHANNEL_PREFIXES.some((p) => name.startsWith(p));
}

function jiraAuthHeader() {
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${token}`, Accept: 'application/json' };
}

// NOTE: Atlassian retired the classic GET /rest/api/3/search endpoint (it now
// returns HTTP 410 Gone). All issue search goes through the newer
// "enhanced JQL search" endpoint, which pages via nextPageToken instead of
// startAt/total, and has no built-in exact count.
async function jiraSearch(jql, fields, maxResults = 100) {
  const url = `${JIRA_SITE}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${fields.join(',')}`;
  const res = await fetch(url, { headers: jiraAuthHeader() });
  if (!res.ok) throw new Error(`Jira search failed (${res.status}): ${jql}`);
  return res.json();
}

// Exact counts are no longer returned by /search/jql, so use the dedicated
// approximate-count endpoint (POST, JSON body) instead.
async function jiraCount(jql) {
  const url = `${JIRA_SITE}/rest/api/3/search/approximate-count`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...jiraAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql }),
  });
  if (!res.ok) throw new Error(`Jira count failed (${res.status}): ${jql}`);
  const json = await res.json();
  return json.count ?? 0;
}

function priorityBucket(name) {
  if (!name) return null;
  const m = name.match(/P([0-3])/i);
  return m ? `P${m[1]}` : null;
}

function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

async function buildJiraData() {
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    console.log('Jira secrets missing — skipping Jira sync, keeping existing data.json values.');
    return null;
  }

  const out = { site: JIRA_SITE };

  // 1) Open bugs by priority (site-wide)
  const openByPriority = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let totalOpen = 0;
  {
    const jql = `issuetype = 버그 AND statusCategory != Done ORDER BY created DESC`;
    let nextPageToken;
    const pageSize = 100;
    const MAX_PAGES = 20; // safety cap (~2000 issues) so a bad query can't loop forever
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ jql, maxResults: String(pageSize), fields: 'priority' });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);
      const url = `${JIRA_SITE}/rest/api/3/search/jql?${params.toString()}`;
      const res = await fetch(url, { headers: jiraAuthHeader() });
      if (!res.ok) throw new Error(`Jira open-bug search failed (${res.status})`);
      const json = await res.json();
      for (const issue of json.issues || []) {
        const bucket = priorityBucket(issue.fields?.priority?.name);
        if (bucket) openByPriority[bucket] = (openByPriority[bucket] || 0) + 1;
      }
      totalOpen += (json.issues || []).length;
      nextPageToken = json.nextPageToken;
      if (json.isLast || !nextPageToken || (json.issues || []).length === 0) break;
    }
  }
  out.open_by_priority = openByPriority;
  out.total_open = totalOpen;

  // 2) New / closed this week (site-wide, bugs)
  out.new_this_week = await jiraCount(`issuetype = 버그 AND created >= -7d`);
  out.closed_this_week = await jiraCount(`issuetype = 버그 AND statusCategory = Done AND resolutiondate >= -7d`);

  // 3) Ticket list — mirrors the saved Jira filter directly (dohands.atlassian.net/issues/?filter=10973).
  // Shown as an actual issue list (key, title, assignee), not an aggregated funnel/bar chart.
  try {
    const json = await jiraSearch(`filter=${FUNNEL_FILTER_ID}`, ['summary', 'status', 'project', 'assignee'], 100);
    out.funnel = (json.issues || [])
      .map((issue) => ({
        key: issue.key,
        url: `${JIRA_SITE}/browse/${issue.key}`,
        summary: issue.fields?.summary || '',
        status: issue.fields?.status?.name || '알 수 없음',
        project: issue.fields?.project?.key || '기타',
        assignee: issue.fields?.assignee?.displayName || '미배정',
      }))
      .sort((a, b) => a.status.localeCompare(b.status) || a.key.localeCompare(b.key));
    out.funnel_filter_id = FUNNEL_FILTER_ID;
    out.funnel_filter_url = `${JIRA_SITE}/issues/?filter=${FUNNEL_FILTER_ID}`;
  } catch (e) {
    console.log(`Funnel query failed: ${e.message}`);
  }

  // 4) Weekly bug inflow by severity (last 8 weeks)
  try {
    const json = await jiraSearch(
      `issuetype = 버그 AND created >= -8w`,
      ['priority', 'created'],
      100
    );
    const weekBuckets = {};
    for (const issue of json.issues || []) {
      const wk = isoWeekKey(issue.fields.created);
      const bucket = priorityBucket(issue.fields?.priority?.name);
      if (!bucket) continue;
      weekBuckets[wk] = weekBuckets[wk] || { p0: 0, p1: 0, p2: 0, p3: 0 };
      weekBuckets[wk][bucket.toLowerCase()]++;
    }
    const weeks = Object.keys(weekBuckets).sort().slice(-8);
    out.weekly_severity = weeks.map((wk, i) => ({ week: `W${i + 1}`, ...weekBuckets[wk] }));
  } catch (e) {
    console.log(`Weekly severity query failed: ${e.message}`);
  }

  // 5) Calendar events from issues with a due date set, restricted to specific people's items
  // (베스현승 / 최라온 / 김태재) rather than every due-dated issue org-wide.
  try {
    const assigneeList = CALENDAR_ASSIGNEE_ACCOUNT_IDS.map((id) => `"${id}"`).join(',');
    const json = await jiraSearch(
      `assignee in (${assigneeList}) AND duedate >= -7d AND duedate <= 45d ORDER BY duedate ASC`,
      ['summary', 'duedate', 'issuetype', 'priority', 'assignee'],
      50
    );
    out.calendar_events_live = (json.issues || []).map((issue) => ({
      date: issue.fields.duedate,
      title: issue.fields.summary,
      type: priorityBucket(issue.fields?.priority?.name) === 'P0' ? 'bug' : 'deadline',
      source: 'jira',
      key: issue.key,
      assignee: issue.fields?.assignee?.displayName || null,
    }));
  } catch (e) {
    console.log(`Calendar due-date query failed: ${e.message}`);
  }

  return out;
}

async function buildConfluenceData() {
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    console.log('Atlassian secrets missing — skipping Confluence sync.');
    return null;
  }
  try {
    const spaceRes = await fetch(`${JIRA_SITE}/wiki/api/v2/spaces?keys=qa&limit=1`, { headers: jiraAuthHeader() });
    if (!spaceRes.ok) throw new Error(`space lookup failed (${spaceRes.status})`);
    const spaceJson = await spaceRes.json();
    const space = spaceJson.results?.[0];
    if (!space) throw new Error('QA space not found');

    const pagesRes = await fetch(
      `${JIRA_SITE}/wiki/api/v2/spaces/${space.id}/pages?limit=6&sort=-modified-date`,
      { headers: jiraAuthHeader() }
    );
    if (!pagesRes.ok) throw new Error(`pages lookup failed (${pagesRes.status})`);
    const pagesJson = await pagesRes.json();

    const docs = (pagesJson.results || []).map((p) => ({
      title: p.title,
      url: `${JIRA_SITE}/wiki${p._links?.webui || ''}`,
      updated: (p.version?.createdAt || '').slice(0, 10),
    }));
    return { space_key: 'qa', docs };
  } catch (e) {
    console.log(`Confluence sync failed: ${e.message}`);
    return null;
  }
}

async function buildSlackData() {
  if (!SLACK_TOKEN) {
    console.log('Slack secret missing — skipping Slack sync.');
    return null;
  }
  const headers = { Authorization: `Bearer ${SLACK_TOKEN}` };

  try {
    // Build a user id -> name map (best effort, ignore failures). Paginate fully
    // so bot users / recently-added members near the end of the list resolve too.
    const userMap = {};
    try {
      let ucursor = '';
      do {
        const url = `https://slack.com/api/users.list?limit=200${ucursor ? `&cursor=${ucursor}` : ''}`;
        const usersRes = await fetch(url, { headers });
        const usersJson = await usersRes.json();
        if (!usersJson.ok) break;
        for (const u of usersJson.members || []) {
          userMap[u.id] = u.profile?.display_name || u.real_name || u.name || u.id;
        }
        ucursor = usersJson.response_metadata?.next_cursor || '';
      } while (ucursor);
    } catch {}

    async function resolveUser(id) {
      if (!id) return '알 수 없음';
      if (userMap[id]) return userMap[id];
      try {
        const res = await fetch(`https://slack.com/api/users.info?user=${id}`, { headers });
        const json = await res.json();
        if (json.ok) {
          const name = json.user?.profile?.display_name || json.user?.real_name || json.user?.name || '알 수 없음';
          userMap[id] = name;
          return name;
        }
      } catch {}
      return '알 수 없음'; // never surface a raw Slack user ID
    }

    // Resolve <@U12345> / <@U12345|label> mention syntax inside message bodies
    // to real display names, so raw user IDs never leak into the feed text either.
    async function resolveMentions(text) {
      const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((mm) => mm[1]))];
      if (!ids.length) return text;
      const names = {};
      for (const id of ids) names[id] = await resolveUser(id);
      return text.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${names[id] || '알 수 없음'}`);
    }

    // List channels (public + private the bot is a member of) and keep only the
    // explicitly requested ones (see SLACK_CHANNEL_NAMES / SLACK_CHANNEL_PREFIXES above).
    const channels = [];
    let cursor = '';
    do {
      const url = `https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await fetch(url, { headers });
      const json = await res.json();
      if (!json.ok) throw new Error(`conversations.list failed: ${json.error}`);
      for (const c of json.channels || []) {
        if (isTargetChannel(c.name)) {
          channels.push({ id: c.id, name: c.name, is_private: !!c.is_private, is_member: !!c.is_member });
        }
      }
      cursor = json.response_metadata?.next_cursor || '';
    } while (cursor);

    // QA team = members of #기술-qa팀. Only messages authored by these people
    // are surfaced in the feed, even from channels with a wider audience
    // (e.g. 기술과제- channels). If the bot isn't in #기술-qa팀 yet (private
    // channel, needs manual /invite), this comes back empty and no messages
    // are shown rather than showing everyone's.
    let qaTeamIds = null;
    const qaChannel = channels.find((c) => c.name === QA_TEAM_CHANNEL_NAME);
    if (qaChannel) {
      try {
        qaTeamIds = new Set();
        let mcursor = '';
        do {
          const url = `https://slack.com/api/conversations.members?channel=${qaChannel.id}&limit=200${mcursor ? `&cursor=${mcursor}` : ''}`;
          const res = await fetch(url, { headers });
          const json = await res.json();
          if (!json.ok) {
            console.log(`Could not read #${QA_TEAM_CHANNEL_NAME} members: ${json.error} (bot likely needs a manual /invite)`);
            qaTeamIds = null;
            break;
          }
          for (const id of json.members || []) qaTeamIds.add(id);
          mcursor = json.response_metadata?.next_cursor || '';
        } while (mcursor);
      } catch (e) {
        console.log(`QA team membership lookup failed: ${e.message}`);
        qaTeamIds = null;
      }
    } else {
      console.log(`#${QA_TEAM_CHANNEL_NAME} not visible to the bot yet — needs a manual /invite. Slack feed will be empty until then.`);
    }

    // Pull recent messages from each matched channel; skip ones the bot can't access
    const allMessages = [];
    for (const ch of channels) {
      try {
        // Public channels: auto-join with channels:join so history reads work
        // without someone manually inviting the bot. Private channels can't be
        // auto-joined — those still need a manual /invite from a channel member.
        if (!ch.is_private && !ch.is_member) {
          const joinRes = await fetch('https://slack.com/api/conversations.join', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: ch.id }),
          });
          const joinJson = await joinRes.json();
          if (!joinJson.ok) {
            console.log(`Could not join #${ch.name}: ${joinJson.error}`);
          }
        }

        const res = await fetch(
          `https://slack.com/api/conversations.history?channel=${ch.id}&limit=20`,
          { headers }
        );
        const json = await res.json();
        if (!json.ok) {
          console.log(`Skipping #${ch.name}: ${json.error}`);
          continue;
        }
        for (const m of json.messages || []) {
          if (!m.text) continue;
          if (m.subtype) continue; // skip channel_join/leave/topic/system messages
          if (m.bot_id) continue; // skip bot/integration messages (Jira, Confluence, etc.)
          if (!m.user) continue; // no human author to check against the QA roster
          if (!qaTeamIds) continue; // no verified QA roster yet -> don't show anyone's messages
          if (!qaTeamIds.has(m.user)) continue; // QA-team-only filter
          const resolvedText = await resolveMentions(m.text);
          allMessages.push({
            channel: ch.name,
            user: await resolveUser(m.user),
            ts: m.ts,
            text: resolvedText.slice(0, 200),
          });
        }
      } catch (e) {
        console.log(`Skipping #${ch.name}: ${e.message}`);
      }
    }
    allMessages.sort((a, b) => Number(b.ts) - Number(a.ts));

    return {
      channel_names: SLACK_CHANNEL_NAMES,
      channel_prefixes: SLACK_CHANNEL_PREFIXES,
      qa_team_size: qaTeamIds ? qaTeamIds.size : null,
      channels,
      messages: allMessages.slice(0, 8),
    };
  } catch (e) {
    console.log(`Slack sync failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const dataPath = new URL('./data.json', import.meta.url);
  const current = JSON.parse(await fs.readFile(dataPath, 'utf8'));

  const [jira, confluence, slack] = await Promise.all([
    buildJiraData(),
    buildConfluenceData(),
    buildSlackData(),
  ]);

  const next = {
    ...current,
    generated_at: new Date().toISOString(),
    source: 'live-sync',
    jira: jira ? { ...current.jira, ...jira } : current.jira,
    // spread so manually-curated fields (e.g. the Confluence QA-pipeline snapshot
    // in `tasks`) survive being overwritten by the live `docs` list each sync
    confluence: confluence ? { ...current.confluence, ...confluence } : current.confluence,
    slack: slack || current.slack,
  };

  await fs.writeFile(dataPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log('data.json updated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
