// ===== Curriculum data layer =====
// Curriculum content (phases/modules/projects) lives entirely in
// curriculum.json, not here. loadCurriculum() is the single boundary the
// rest of the app depends on — nothing else needs to know whether this data
// came from a local JSON file or, later, from Firestore. Swapping the
// source later means changing only this one function's body.
let PHASE_PROJECTS = {};
let PHASE_ORDER = [];
let PHASES = [];
let PROJECTS = [];
let PROJECTS_BY_ID = new Map();
let PHASE_BOSSES = [];
let PHASE_BOSSES_BY_ID = new Map();
let TOPICS = [];
let TOPICS_BY_ID = new Map();
let CURRICULUM_META = {};
const QUIZ_BANK = {}; // no quiz content for the new curriculum yet — left empty on purpose, not invented

async function loadCurriculum(){
  const res = await fetch('curriculum.json');
  if(!res.ok) throw new Error('Failed to load curriculum.json: HTTP ' + res.status);
  return await res.json();
}

function phaseLabel(phase){
  return phase.id.toUpperCase() + ' — ' + phase.title;
}

// Folds a phase's optional project + boss battle into one display string —
// the same shape the old hardcoded PHASE_PROJECTS values were, so the
// existing phase-project UI box needs no changes.
function buildPhaseProjectText(phase){
  const parts = [];
  if(phase.project){
    const p = phase.project;
    let text = `PROJECT — ${p.title}. ${p.purpose} Build: ${p.build}`;
    if(p.bossChallenge) text += ` Boss challenge: ${p.bossChallenge}`;
    if(p.passGate) text += ` Pass gate: ${p.passGate}`;
    parts.push(text);
  }
  if(phase.boss){
    const b = phase.boss;
    let text = `BOSS BATTLE — ${b.title}. ${b.build}`;
    if(b.challenge) text += ` Challenge: ${b.challenge}`;
    if(b.passGate) text += ` Pass gate: ${b.passGate}`;
    parts.push(text);
  }
  return parts.join(' ');
}

function depthLabel(depth){
  return depth ? depth.charAt(0).toUpperCase() + depth.slice(1) : '';
}

async function initCurriculumData(){
  let curriculum;
  try{
    curriculum = await loadCurriculum();
  } catch(e){
    console.error('Curriculum failed to load', e);
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;max-width:500px;margin:0 auto">' +
      '<h2>Could not load curriculum.json</h2><p>' + e.message + '</p></div>';
    throw e;
  }

  CURRICULUM_META = curriculum.meta || {};
  const sortedPhases = [...curriculum.phases].sort((a,b)=>a.order-b.order);
  PHASES = sortedPhases.map(phase=>({
    id:phase.id,
    order:phase.order,
    title:phase.title,
    project:phase.project ? Object.assign({phaseId:phase.id,phaseOrder:phase.order,phaseTitle:phase.title}, phase.project) : null,
    boss:phase.boss ? Object.assign({phaseId:phase.id,phaseOrder:phase.order,phaseTitle:phase.title}, phase.boss) : null
  }));
  PROJECTS = PHASES.filter(phase=>phase.project).map(phase=>phase.project);
  PROJECTS_BY_ID = new Map(PROJECTS.map(project=>[project.id, project]));
  PHASE_BOSSES = PHASES.filter(phase=>phase.boss).map(phase=>phase.boss);
  PHASE_BOSSES_BY_ID = new Map(PHASE_BOSSES.map(boss=>[boss.phaseId, boss]));
  PHASE_ORDER = sortedPhases.map(phaseLabel);
  PHASE_PROJECTS = {};
  TOPICS = [];

  sortedPhases.forEach(phase=>{
    const label = phaseLabel(phase);
    const projText = buildPhaseProjectText(phase);
    if(projText) PHASE_PROJECTS[label] = projText;

    phase.modules.forEach((m,moduleOrder)=>{
      TOPICS.push({
        id: m.id,
        phase: label,
        phaseId: phase.id,
        phaseOrder: phase.order,
        moduleOrder: moduleOrder,
        title: m.title,
        desc: Array.isArray(m.handsOn) ? m.handsOn.join(' ') : (m.handsOn || ''),
        tradeoff: m.masteryGate ? ('Mastery gate: ' + m.masteryGate) : '',
        example: m.firstAction ? ('First action: ' + m.firstAction) : '',
        skill: depthLabel(m.depth),
        depth: m.depth || 'core', // raw value ('core'/'deep') — drives promotion rules in the progress model
        mustCover: m.mustCover || [],
        prerequisites: m.prerequisites || '',
        firstAction: m.firstAction || '',
        handsOn: m.handsOn || '',
        masteryGate: m.masteryGate || '',
        conceptChunks: m.conceptChunks || []
      });
    });
  });

  TOPICS_BY_ID = new Map(TOPICS.map(t=>[t.id, t]));
}

// Kicked off immediately so the fetch is well underway (usually finished)
// by the time a human has typed the password — tryUnlock() and the
// auto-unlock branch below both await this same promise before calling
// init(), so there's no race regardless of timing.
const curriculumReady = initCurriculumData();

let activePhase='all';
let activeStatus='all';
let showCoreOnly=false;

function toggleCoreOnly(){
  showCoreOnly = !showCoreOnly;
  document.getElementById('core-toggle-btn').classList.toggle('active', showCoreOnly);
  applyFilters();
}

// ===== Progress model =====
// One record per topic, stored at localStorage key `progress:{topicId}`.
// A topic is a flat checklist: read each concept chunk, do its hands-on
// project. No grading — the app trusts the checkbox. getTopicProgress()/
// saveProgressRecord() form the storage boundary, following the same
// swappable-boundary pattern as loadCurriculum() from Step 1 — pointing
// this at Firestore later means rewriting these storage functions rather
// than the UI.

const APP_STATE_KEY = 'appState';
const XP_EVENTS_KEY = 'xpEvents';
let appState = {lastActiveTopicId:null, lastActiveAt:null, xpTotal:0, currentRank:null};
let comebackPending = false;
let comebackRewardPending = false;

function defaultProgressRecord(topicId, depth){
  return {
    topicId: topicId,
    depth: depth || 'core',
    chunksRead: [],
    handsOnDone: [],
    completedAt: null,
    lastStudiedAt: null,
    activityDates: []
  };
}

// A topic is complete when every chunk is read and every chunk's hands-on
// project is marked done. No partial credit, no quality bar — that
// verification now happens in conversation with an AI TA, not in this app.
function isTopicComplete(record, topic){
  const t = topic || TOPICS_BY_ID.get(record.topicId);
  const n = t && Array.isArray(t.conceptChunks) ? t.conceptChunks.length : 0;
  if(!n) return false;
  return record.chunksRead.length === n && record.chunksRead.every(Boolean) &&
    record.handsOnDone.length === n && record.handsOnDone.every(Boolean);
}

// ===== Projects and boss progress =====
// Curriculum definitions stay immutable; these additive records contain only
// the learner's state and can be replaced with another persistence boundary.
function defaultProjectProgress(project){
  return {
    projectId: project.id,
    status: 'not-started',
    startedAt: null,
    currentMilestoneIndex: 0,
    milestones: [],
    blocked: {isBlocked:false, reason:null},
    boss: {attempted:false, passed:false, notes:null, completedAt:null},
    postmortem: null,
    nextAction: (project.milestones && project.milestones[0]) || ''
  };
}

function getProjectProgress(projectId){
  const project = PROJECTS_BY_ID.get(projectId);
  if(!project) return null;
  let stored = null;
  try{
    const raw = localStorage.getItem('projectProgress:' + projectId);
    if(raw) stored = JSON.parse(raw);
  } catch(e){ stored = null; }
  const fallback = defaultProjectProgress(project);
  const record = Object.assign({}, fallback, stored || {});
  record.milestones = Array.isArray(record.milestones) ? record.milestones : [];
  record.blocked = Object.assign({}, fallback.blocked, record.blocked || {});
  record.boss = Object.assign({}, fallback.boss, record.boss || {});
  record.currentMilestoneIndex = Math.max(0, Math.min(
    project.milestones.length,
    Number.isInteger(record.currentMilestoneIndex) ? record.currentMilestoneIndex : record.milestones.length
  ));
  if(record.blocked.isBlocked) record.status = 'blocked';
  else if(record.status === 'blocked') record.status = 'active';
  if(!['not-started','active','blocked','complete'].includes(record.status)) record.status = 'not-started';
  return record;
}

function saveProjectProgress(record){
  localStorage.setItem('projectProgress:' + record.projectId, JSON.stringify(record));
}

function defaultBossProgress(){
  return {passed:false, notes:null, completedAt:null};
}

function getBossProgress(phaseId){
  if(!PHASE_BOSSES_BY_ID.has(phaseId)) return null;
  let stored = null;
  try{
    const raw = localStorage.getItem('bossProgress:' + phaseId);
    if(raw) stored = JSON.parse(raw);
  } catch(e){ stored = null; }
  return Object.assign(defaultBossProgress(), stored || {});
}

function saveBossProgress(phaseId, record){
  localStorage.setItem('bossProgress:' + phaseId, JSON.stringify(record));
}

function projectProgressSnapshot(projects){
  const snapshot = {};
  (projects || PROJECTS).forEach(project=>{ snapshot[project.id] = getProjectProgress(project.id); });
  return snapshot;
}

function bossProgressSnapshot(bosses){
  const snapshot = {};
  (bosses || PHASE_BOSSES).forEach(boss=>{ snapshot[boss.phaseId] = getBossProgress(boss.phaseId); });
  return snapshot;
}

function phaseTopicsFor(phaseId, topics){
  return (topics || TOPICS).filter(topic=>topic.phaseId === phaseId);
}

// Availability is intentionally a recommendation, not a hard lock.
function isProjectAvailable(project, topics, progressById){
  const phaseTopics = phaseTopicsFor(project.phaseId, topics);
  return phaseTopics.length > 0 && phaseTopics.every(topic=>{
    const progress = progressById[topic.id];
    return progress && isTopicComplete(progress, topic);
  });
}

function isBossAvailable(boss, topics, progressById){
  const phaseTopics = phaseTopicsFor(boss.phaseId, topics);
  return phaseTopics.length > 0 && phaseTopics.every(topic=>{
    const progress = progressById[topic.id];
    return progress && isTopicComplete(progress, topic);
  });
}

function phaseTopicsAtTargetMastery(phaseId, topics, progressById){
  const phaseTopics = phaseTopicsFor(phaseId, topics);
  return phaseTopics.length > 0 && phaseTopics.every(topic=>{
    const progress = progressById[topic.id];
    return progress && isTopicComplete(progress, topic);
  });
}

function remainingPhaseModules(phaseId, topics, progressById){
  return phaseTopicsFor(phaseId, topics).filter(topic=>{
    const progress = progressById[topic.id];
    return !progress || !isTopicComplete(progress, topic);
  });
}

function getTopicProgress(topicId){
  let record = null;
  try{
    const raw = localStorage.getItem('progress:'+topicId);
    if(raw) record = JSON.parse(raw);
  } catch(e){ record = null; }
  const t = TOPICS_BY_ID.get(topicId);
  const chunkCount = t && Array.isArray(t.conceptChunks) ? t.conceptChunks.length : 0;
  if(record && (record.evidence || Number.isInteger(record.masteryLevel))){
    // Legacy mastery-loop record from before the loop was removed. A topic
    // that had reached Assisted mastery (masteryLevel >= 2) or higher is
    // carried forward as fully complete; anything less is reset to fresh —
    // partial loop evidence has no clean mapping onto per-chunk checkboxes.
    const wasSolid = Number(record.masteryLevel) >= 2;
    record = defaultProgressRecord(topicId, t ? t.depth : record.depth);
    if(wasSolid){
      record.chunksRead = new Array(chunkCount).fill(true);
      record.handsOnDone = new Array(chunkCount).fill(true);
      record.completedAt = new Date().toISOString();
    }
    saveProgressRecord(record);
  }
  if(!record){
    record = defaultProgressRecord(topicId, t ? t.depth : 'core');
  }
  if(!Array.isArray(record.chunksRead)) record.chunksRead = [];
  if(!Array.isArray(record.handsOnDone)) record.handsOnDone = [];
  if(!Array.isArray(record.activityDates)) record.activityDates = [];
  while(record.chunksRead.length < chunkCount) record.chunksRead.push(false);
  while(record.handsOnDone.length < chunkCount) record.handsOnDone.push(false);
  record.chunksRead.length = chunkCount;
  record.handsOnDone.length = chunkCount;
  return record;
}

function saveProgressRecord(record){
  localStorage.setItem('progress:'+record.topicId, JSON.stringify(record));
}

function loadAppState(){
  let stored = null;
  try{
    const raw = localStorage.getItem(APP_STATE_KEY);
    if(raw) stored = JSON.parse(raw);
  } catch(e){ stored = null; }
  appState = {
    lastActiveTopicId: stored && typeof stored.lastActiveTopicId === 'string' ? stored.lastActiveTopicId : null,
    lastActiveAt: stored && stored.lastActiveAt ? stored.lastActiveAt : null,
    xpTotal: stored && Number.isFinite(stored.xpTotal) ? Math.max(0, Math.round(stored.xpTotal)) : 0,
    currentRank: stored && typeof stored.currentRank === 'string' ? stored.currentRank : null
  };
}

function saveAppState(){
  localStorage.setItem(APP_STATE_KEY, JSON.stringify({
    lastActiveTopicId: appState.lastActiveTopicId,
    lastActiveAt: appState.lastActiveAt,
    xpTotal: appState.xpTotal,
    currentRank: appState.currentRank
  }));
}

const XP_TABLE_LABELS = {
  'focus-block':'Focus block completed',
  'chunk-read':'Chunk read',
  'handson-done':'Hands-on completed',
  'topic-complete':'Topic completed',
  'quiz-passed':'Quiz passed',
  'project-milestone':'Project milestone',
  'boss':'Capstone passed'
};
const FIXED_XP_AMOUNTS = {
  'comeback':30
};
const XP_DISPLAY_LABELS = {
  'focus-block':'Focus block',
  'chunk-read':'Chunk read',
  'handson-done':'Hands-on completed',
  'topic-complete':'Topic completed',
  'quiz-passed':'Quiz passed',
  'project-milestone':'Project milestone',
  'boss':'Capstone passed'
};

function getXPEvents(){
  try{
    const parsed = JSON.parse(localStorage.getItem(XP_EVENTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch(e){ return []; }
}

function saveXPEvents(events){
  localStorage.setItem(XP_EVENTS_KEY, JSON.stringify(events));
}

function xpAmountForAction(action){
  if(Object.prototype.hasOwnProperty.call(FIXED_XP_AMOUNTS, action)) return FIXED_XP_AMOUNTS[action];
  const label = XP_TABLE_LABELS[action];
  const row = (CURRICULUM_META.xpTable || []).find(item=>item.action === label);
  return row && Number.isFinite(row.xp) ? row.xp : null;
}

function rankForXP(total){
  const ranks = [...(CURRICULUM_META.ranks || [])].sort((a,b)=>a.xp-b.xp);
  return ranks.reduce((current,rank)=>total >= rank.xp ? rank : current, ranks[0] || {name:'',xp:0});
}

function recomputeXPState(save){
  appState.xpTotal = getXPEvents().reduce((sum,event)=>sum + (Number(event.xp) || 0), 0);
  appState.currentRank = rankForXP(appState.xpTotal).name || null;
  if(save !== false) saveAppState();
  return appState.xpTotal;
}

function newXPEventId(){
  return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID()
    : 'xp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10);
}

let pendingXPToasts = [];
let xpToastTimer = null;

function queueXPToast(event, rankUpName){
  pendingXPToasts.push({event:event,rankUpName:rankUpName || null});
  if(xpToastTimer) return;
  xpToastTimer = setTimeout(()=>{
    const batch = pendingXPToasts.splice(0);
    xpToastTimer = null;
    const parts = batch.map(item=>item.event.action === 'comeback'
      ? 'Welcome back +30'
      : '+' + item.event.xp + ' XP — ' + (XP_DISPLAY_LABELS[item.event.action] || item.event.action));
    const rankUps = [...new Set(batch.map(item=>item.rankUpName).filter(Boolean))];
    rankUps.forEach(name=>parts.push('Rank up — ' + name));
    showToast(parts.join(' · '));
  }, 60);
}

// The only XP write boundary. Ledger entries are append-only and idempotent
// on refId — each caller passes a refId unique to the thing being rewarded
// (a specific chunk, hands-on, topic, quiz, etc.) so re-toggling never
// double-grants.
function grantXP(action, refId, options){
  options = options || {};
  const reference = String(refId || '').trim();
  if(!reference) throw new Error('XP refId is required');
  const events = getXPEvents();
  if(events.some(event=>event.refId === reference)) return null;
  const timestamp = options.timestamp || new Date().toISOString();
  const xp = xpAmountForAction(action);
  if(!Number.isFinite(xp)) throw new Error('Unknown XP action: ' + action);
  const previousRank = rankForXP(events.reduce((sum,event)=>sum + (Number(event.xp) || 0), 0)).name;
  const event = {
    id:newXPEventId(), timestamp:timestamp, action:action, xp:xp,
    refType:options.refType || 'event', refId:reference
  };
  if(options.topicId) event.topicId = options.topicId;
  events.push(event);
  saveXPEvents(events);
  recomputeXPState(false);
  saveAppState();
  const newRank = appState.currentRank;
  queueXPToast(event, previousRank && newRank !== previousRank ? newRank : null);
  if(activeAppView === 'today') renderTodayDashboard();
  pushCloudState();
  return event;
}

function grantComebackXPIfPending(timestamp){
  if(!comebackRewardPending) return null;
  comebackRewardPending = false;
  sessionStorage.setItem('fnd-comeback-xp-pending', '');
  return grantXP('comeback', 'comeback:' + localDayKey(timestamp), {timestamp:timestamp,refType:'comeback'});
}

function markAppActivity(topicId, timestamp){
  appState.lastActiveTopicId = topicId || null;
  appState.lastActiveAt = timestamp || new Date().toISOString();
  comebackPending = false;
  saveAppState();
}

function initializeComebackState(now){
  comebackPending = false;
  comebackRewardPending = false;
  if(!appState.lastActiveAt) return;
  const last = new Date(appState.lastActiveAt);
  const current = now == null ? new Date() : new Date(now);
  if(Number.isNaN(last.getTime()) || Number.isNaN(current.getTime())) return;
  const isComeback = current.getTime() - last.getTime() >= 48 * 60 * 60 * 1000;
  const seenKey = sessionStorage.getItem('fnd-comeback-seen');
  if(isComeback && seenKey !== appState.lastActiveAt){
    comebackPending = true;
    comebackRewardPending = true;
    sessionStorage.setItem('fnd-comeback-seen', appState.lastActiveAt);
    sessionStorage.setItem('fnd-comeback-xp-pending', appState.lastActiveAt);
  } else if(isComeback && sessionStorage.getItem('fnd-comeback-xp-pending') === appState.lastActiveAt){
    comebackRewardPending = true;
  }
}

function levelOf(id){
  const t = TOPICS_BY_ID.get(id);
  const record = getTopicProgress(id);
  if(isTopicComplete(record, t)) return 3;
  const anyDone = record.chunksRead.some(Boolean) || record.handsOnDone.some(Boolean);
  return anyDone ? 1 : 0;
}

function progressSnapshot(){
  const snapshot = {};
  TOPICS.forEach(topic=>{ snapshot[topic.id] = getTopicProgress(topic.id); });
  return snapshot;
}

function phasePrerequisitesSatisfied(topic, topics, progressById){
  if(topic.phaseId === 'p1') return true;
  const priorOrders = topics.map(item=>item.phaseOrder).filter(order=>order < topic.phaseOrder);
  if(!priorOrders.length) return true;
  const previousOrder = Math.max.apply(null, priorOrders);
  const previousTopics = topics.filter(item=>item.phaseOrder === previousOrder);
  if(!previousTopics.length) return false;
  const completeCount = previousTopics.filter(item=>{
    const progress = progressById[item.id];
    return progress && isTopicComplete(progress, item);
  }).length;
  return completeCount / previousTopics.length >= 0.5;
}

// Pure next-item engine. Each rule returns null when it does not match, so
// future project and boss rules can be inserted before the final rule.
function pickNextAction(topics, progressById, projects, projectProgressById, bosses, bossProgressByPhaseId){
  const orderedTopics = [...topics].sort((a,b)=>
    a.phaseOrder - b.phaseOrder || a.moduleOrder - b.moduleOrder || a.id.localeCompare(b.id)
  );
  const orderedProjects = [...(projects || [])].sort((a,b)=>a.phaseOrder - b.phaseOrder || a.id.localeCompare(b.id));
  const orderedBosses = [...(bosses || [])].sort((a,b)=>a.phaseOrder - b.phaseOrder || a.phaseId.localeCompare(b.phaseId));
  const projectState = projectProgressById || {};
  const bossState = bossProgressByPhaseId || {};
  const rules = [
    function resumeInProgressTopic(){
      const candidates = orderedTopics.map(topic=>{
        const progress = progressById[topic.id] || defaultProgressRecord(topic.id, topic.depth);
        return {topic:topic, progress:progress};
      }).filter(item=>{
        const anyDone = item.progress.chunksRead.some(Boolean) || item.progress.handsOnDone.some(Boolean);
        return anyDone && !isTopicComplete(item.progress, item.topic);
      }).sort((a,b)=>{
        const aTime = a.progress.lastStudiedAt ? new Date(a.progress.lastStudiedAt).getTime() : 0;
        const bTime = b.progress.lastStudiedAt ? new Date(b.progress.lastStudiedAt).getTime() : 0;
        return bTime - aTime;
      });
      if(!candidates.length) return null;
      const chosen = candidates[0];
      const unreadChunk = chosen.progress.chunksRead.findIndex(v=>!v);
      const unfinishedHandsOn = chosen.progress.handsOnDone.findIndex(v=>!v);
      const sublabel = unreadChunk !== -1
        ? 'Next: read chunk ' + (unreadChunk + 1)
        : unfinishedHandsOn !== -1
          ? 'Next: hands-on for chunk ' + (unfinishedHandsOn + 1)
          : 'Pick up where you left off';
      return {
        type:'resume',
        topicId:chosen.topic.id,
        label:'Continue: ' + chosen.topic.title,
        sublabel:sublabel
      };
    },
    function nextTopicInSequence(){
      const topic = orderedTopics.find(item=>{
        const progress = progressById[item.id] || defaultProgressRecord(item.id, item.depth);
        return !isTopicComplete(progress, item) &&
          phasePrerequisitesSatisfied(item, orderedTopics, progressById);
      });
      if(!topic) return null;
      return {
        type:'start',
        topicId:topic.id,
        label:'Start: ' + topic.title,
        sublabel:topic.firstAction
      };
    },
    function activeProjectMilestone(){
      const project = orderedProjects.find(item=>{
        const state = projectState[item.id];
        return state && state.status === 'active' && !(state.blocked && state.blocked.isBlocked) &&
          state.currentMilestoneIndex < item.milestones.length &&
          phaseTopicsAtTargetMastery(item.phaseId, orderedTopics, progressById);
      });
      if(!project) return null;
      const state = projectState[project.id];
      return {
        type:'project',
        topicId:null,
        projectId:project.id,
        label:'Project: ' + project.title,
        sublabel:String(state.nextAction || '').trim() || project.milestones[state.currentMilestoneIndex]
      };
    },
    function availableBossChallenge(){
      const project = orderedProjects.find(item=>{
        const state = projectState[item.id];
        return state && state.status === 'active' && !(state.blocked && state.blocked.isBlocked) &&
          state.currentMilestoneIndex >= item.milestones.length && !(state.boss && state.boss.passed) &&
          isProjectAvailable(item, orderedTopics, progressById);
      });
      if(project){
        return {
          type:'boss', bossKind:'project', topicId:null, projectId:project.id, phaseId:project.phaseId,
          label:'Boss: ' + project.title,
          sublabel:project.bossChallenge
        };
      }
      const phaseBoss = orderedBosses.find(item=>{
        const state = bossState[item.phaseId] || defaultBossProgress();
        return !state.passed && isBossAvailable(item, orderedTopics, progressById);
      });
      if(!phaseBoss) return null;
      return {
        type:'boss', bossKind:'phase', topicId:null, projectId:null, phaseId:phaseBoss.phaseId,
        label:'Boss: ' + phaseBoss.title,
        sublabel:phaseBoss.build
      };
    },
    function allCaughtUp(){
      return {
        type:'done',
        topicId:null,
        label:'All caught up',
        sublabel:'Open Roadmap to browse the curriculum.'
      };
    }
  ];
  for(const rule of rules){
    const result = rule();
    if(result) return result;
  }
}

function localDayKey(value){
  const date = new Date(value);
  if(Number.isNaN(date.getTime())) return null;
  return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
}

function deriveActiveDayKeys(topics, progressById){
  const days = new Set();
  topics.forEach(topic=>{
    const progress = progressById[topic.id];
    if(!progress) return;
    (progress.activityDates || []).forEach(key=>{ if(key) days.add(key); });
  });
  return days;
}

function lastSevenDayKeys(referenceDate){
  const end = referenceDate == null ? new Date() : new Date(referenceDate);
  end.setHours(12,0,0,0);
  const keys = [];
  for(let offset=6; offset>=0; offset--){
    const day = new Date(end);
    day.setDate(end.getDate() - offset);
    keys.push(localDayKey(day));
  }
  return keys;
}

function mostRecentlyStudiedTopic(topics, progressById){
  return topics.map(topic=>({topic:topic,progress:progressById[topic.id]}))
    .filter(item=>item.progress && item.progress.lastStudiedAt)
    .sort((a,b)=>new Date(b.progress.lastStudiedAt) - new Date(a.progress.lastStudiedAt))[0] || null;
}

let activeAppView = 'today';
let currentTodayAction = null;

function setNavigationActive(name){
  ['today','learn','projects','roadmap'].forEach(tab=>{
    const el = document.getElementById('tab-' + tab);
    if(el) el.classList.toggle('active', tab === name);
  });
}

function showAppView(name){
  const today = document.getElementById('today-view');
  const projects = document.getElementById('projects-view');
  const roadmapSurfaces = document.querySelectorAll('.roadmap-surface');
  activeAppView = ['today','projects','roadmap'].includes(name) ? name : 'today';
  if(today) today.hidden = activeAppView !== 'today';
  if(projects) projects.hidden = activeAppView !== 'projects';
  roadmapSurfaces.forEach(surface=>{ surface.hidden = activeAppView !== 'roadmap'; });
  setNavigationActive(activeAppView);
  if(activeAppView === 'today') renderTodayDashboard();
  if(activeAppView === 'projects') renderProjectsView();
}

function buildTodayAction(){
  const snapshot = progressSnapshot();
  return pickNextAction(TOPICS, snapshot, PROJECTS, projectProgressSnapshot(), PHASE_BOSSES, bossProgressSnapshot());
}

function renderTodayXPLine(){
  const ranks = [...(CURRICULUM_META.ranks || [])].sort((a,b)=>a.xp-b.xp);
  if(!ranks.length) return '';
  const total = appState.xpTotal || 0;
  const current = rankForXP(total);
  const next = ranks.find(rank=>rank.xp > total) || null;
  const span = next ? Math.max(1, next.xp - current.xp) : 1;
  const progress = next ? Math.max(0, Math.min(100, Math.round((total - current.xp) / span * 100))) : 100;
  return '<div class="xp-rank-line">' +
    '<div class="xp-rank-meta"><span>' + escapeHtml(current.name) + '</span><span>' + total + ' XP' +
      (next ? ' · next ' + escapeHtml(next.name) : '') + '</span></div>' +
    '<div class="xp-rank-track" aria-label="' + progress + '% to the next rank"><div class="xp-rank-fill" style="width:' + progress + '%"></div></div>' +
  '</div>';
}

function renderTodayDashboard(){
  const container = document.getElementById('today-content');
  if(!container || !TOPICS.length) return;
  const snapshot = progressSnapshot();
  const projectsState = projectProgressSnapshot();
  const action = pickNextAction(TOPICS, snapshot, PROJECTS, projectsState, PHASE_BOSSES, bossProgressSnapshot());
  currentTodayAction = action;
  const activeDays = deriveActiveDayKeys(TOPICS, snapshot);
  sessionActiveDayKeys().forEach(key=>activeDays.add(key)); // completed focus blocks count too
  const momentum = lastSevenDayKeys(new Date()).map(key=>
    '<span class="momentum-dot ' + (activeDays.has(key) ? 'filled' : '') +
      '" title="' + escapeHtml(key) + '" aria-label="' + escapeHtml(key + (activeDays.has(key) ? ' active' : '')) + '"></span>'
  ).join('');
  let html = '';
  if(comebackPending){
    const recent = mostRecentlyStudiedTopic(TOPICS, snapshot);
    html += '<div class="comeback-banner">Welcome back' +
      (recent ? ' — you were last on "' + escapeHtml(recent.topic.title) + '"' : '') + '.</div>';
    html += '<div class="loop-actions"><button class="pomo-btn" onclick="skipComebackWarmup()">Continue</button></div>';
  }
  const focusable = action.topicId || (action.type !== 'done' && focusBoundTopicId());
  html += '<div class="today-primary">' +
    '<div class="loop-eyebrow">Continue</div>' +
    '<div class="loop-title">' + escapeHtml(action.label) + '</div>' +
    '<div class="today-sublabel">' + escapeHtml(action.sublabel) + '</div>' +
    '<div class="loop-actions">' +
      '<button class="pomo-btn primary" onclick="handleTodayContinue()">Open</button>' +
      (focusable ? '<button class="pomo-btn" onclick="startFocusFromToday()">Start a focus block</button>' : '') +
    '</div>' +
  '</div>';
  html += '<div class="momentum-card">' +
    '<div class="tcard-title">Momentum</div>' +
    '<div class="momentum-dots" aria-label="Activity over the last seven days">' + momentum + '</div>' +
  '</div>';
  const activeProject = PROJECTS.find(project=>{
    const state = projectsState[project.id];
    return state && state.status === 'active' && !(state.blocked && state.blocked.isBlocked);
  });
  if(activeProject){
    const state = projectsState[activeProject.id];
    const milestone = state.currentMilestoneIndex < activeProject.milestones.length
      ? activeProject.milestones[state.currentMilestoneIndex]
      : state.boss.passed ? 'Write the project postmortem' : 'Attempt the boss challenge';
    html += '<button class="today-project-card" onclick="openProjectDetail(\'' + escapeHtml(activeProject.id) + '\')">' +
      '<div class="tcard-title">Project</div>' +
      '<div class="loop-title">' + escapeHtml(activeProject.title) + '</div>' +
      '<div class="project-card-copy">' + escapeHtml(milestone) + '</div>' +
      '<div class="today-sublabel">' + escapeHtml(String(state.nextAction || '').trim() || milestone) + '</div>' +
    '</button>';
  }
  html += renderTodayXPLine();
  container.innerHTML = html;
}

function handleTodayContinue(){
  if(!currentTodayAction) currentTodayAction = buildTodayAction();
  comebackPending = false;
  if(currentTodayAction.type === 'project'){
    openProjectDetail(currentTodayAction.projectId);
  } else if(currentTodayAction.type === 'boss'){
    if(currentTodayAction.bossKind === 'project') openProjectDetail(currentTodayAction.projectId);
    else openPhaseBoss(currentTodayAction.phaseId);
  } else if(currentTodayAction.topicId){
    openTopicModal(currentTodayAction.topicId);
  } else {
    showAppView('roadmap');
  }
}

function openLearnView(){
  setNavigationActive('learn');
  const snapshot = progressSnapshot();
  const action = pickNextAction(TOPICS, snapshot, PROJECTS, projectProgressSnapshot(), PHASE_BOSSES, bossProgressSnapshot());
  if(action.topicId) openTopicModal(action.topicId);
  else showAppView('roadmap');
}

function skipComebackWarmup(){
  comebackPending = false;
  renderTodayDashboard();
}

let currentProjectDetail = null; // {kind:'project'|'phase-boss', id:string}

function refreshProjectSurfaces(){
  pushCloudState();
  renderTodayDashboard();
  if(activeAppView === 'projects') renderProjectsView();
  if(currentProjectDetail) renderProjectDetail();
}

function startProject(projectId, timestamp){
  const project = PROJECTS_BY_ID.get(projectId);
  const record = getProjectProgress(projectId);
  if(!project || !record) return null;
  if(record.status === 'not-started'){
    record.status = 'active';
    record.startedAt = timestamp || new Date().toISOString();
    record.nextAction = project.milestones[record.currentMilestoneIndex] || project.bossChallenge;
    saveProjectProgress(record);
    refreshProjectSurfaces();
  }
  return record;
}

function completeProjectMilestone(projectId, artifactNote, timestamp){
  const project = PROJECTS_BY_ID.get(projectId);
  const record = getProjectProgress(projectId);
  const note = String(artifactNote || '').trim();
  if(!project || !record) throw new Error('Project not found');
  if(!note) throw new Error('Add one line describing what this milestone produced.');
  if(record.status !== 'active') throw new Error('Start or unblock this project first.');
  if(record.currentMilestoneIndex >= project.milestones.length) return record;
  const index = record.currentMilestoneIndex;
  const completedAt = timestamp || new Date().toISOString();
  let added = false;
  if(!record.milestones.some(item=>item.index === index)){
    record.milestones.push({index:index, completedAt:completedAt, artifactNote:note});
    added = true;
  }
  record.currentMilestoneIndex = index + 1;
  record.nextAction = record.currentMilestoneIndex < project.milestones.length
    ? project.milestones[record.currentMilestoneIndex]
    : project.bossChallenge;
  saveProjectProgress(record);
  if(added){
    grantXP('project-milestone', projectId + ':milestone:' + index, {
      timestamp:completedAt,refType:'project-milestone'
    });
  }
  refreshProjectSurfaces();
  return record;
}

function updateProjectNextAction(projectId, nextAction){
  const record = getProjectProgress(projectId);
  if(!record || record.status !== 'active') return null;
  const value = String(nextAction || '').trim();
  if(value) record.nextAction = value;
  saveProjectProgress(record);
  refreshProjectSurfaces();
  return record;
}

function setProjectBlocked(projectId, isBlocked, reason){
  const record = getProjectProgress(projectId);
  if(!record) throw new Error('Project not found');
  if(isBlocked){
    const value = String(reason || '').trim();
    if(!value) throw new Error('Add the reason this project is blocked.');
    if(record.status === 'not-started') throw new Error('Start the project before marking it blocked.');
    record.blocked = {isBlocked:true, reason:value};
    record.status = 'blocked';
  } else {
    record.blocked = {isBlocked:false, reason:null};
    if(record.status !== 'complete') record.status = 'active';
  }
  saveProjectProgress(record);
  refreshProjectSurfaces();
  return record;
}

function recordProjectBossAttempt(projectId, passed, notes, timestamp){
  const project = PROJECTS_BY_ID.get(projectId);
  const record = getProjectProgress(projectId);
  const value = String(notes || '').trim();
  if(!project || !record) throw new Error('Project not found');
  if(record.currentMilestoneIndex < project.milestones.length) throw new Error('Complete the milestones first.');
  if(record.status !== 'active') throw new Error('Unblock this project first.');
  if(!value) throw new Error('Record what happened in the boss challenge.');
  const wasPassed = !!record.boss.passed;
  const completedAt = passed ? (timestamp || new Date().toISOString()) : null;
  record.boss = {
    attempted:true,
    passed:!!passed,
    notes:value,
    completedAt:completedAt
  };
  if(passed) record.nextAction = 'Write the project postmortem';
  saveProjectProgress(record);
  if(passed && !wasPassed){
    grantXP('boss', projectId + ':boss', {timestamp:completedAt,refType:'project-boss'});
  }
  refreshProjectSurfaces();
  return record;
}

function completeProjectPostmortem(projectId, postmortem){
  const project = PROJECTS_BY_ID.get(projectId);
  const record = getProjectProgress(projectId);
  const value = String(postmortem || '').trim();
  if(!project || !record) throw new Error('Project not found');
  if(record.currentMilestoneIndex < project.milestones.length || !record.boss.passed){
    throw new Error('Complete the milestones and pass the boss first.');
  }
  if(!value) throw new Error('Add the project postmortem before completing it.');
  record.postmortem = value;
  record.status = 'complete';
  record.blocked = {isBlocked:false, reason:null};
  record.nextAction = '';
  saveProjectProgress(record);
  refreshProjectSurfaces();
  return record;
}

function recordPhaseBossAttempt(phaseId, passed, notes, timestamp){
  const boss = PHASE_BOSSES_BY_ID.get(phaseId);
  const previous = getBossProgress(phaseId);
  const value = String(notes || '').trim();
  if(!boss) throw new Error('Boss challenge not found');
  if(!isBossAvailable(boss, TOPICS, progressSnapshot())) throw new Error('Complete this phase\'s topics first.');
  if(!value) throw new Error('Record what happened in the boss challenge.');
  const record = {passed:!!passed, notes:value, completedAt:passed ? (timestamp || new Date().toISOString()) : null};
  saveBossProgress(phaseId, record);
  if(passed && !previous.passed){
    grantXP('boss', phaseId + ':boss', {timestamp:record.completedAt,refType:'phase-boss'});
  }
  refreshProjectSurfaces();
  return record;
}

function projectStatusLabel(project, record, available){
  if(record.status === 'complete') return 'Complete';
  if(record.blocked.isBlocked) return 'Blocked';
  if(record.status === 'active') return 'Active';
  return available ? 'Available' : 'Not started';
}

function renderRemainingModules(phaseId, snapshot){
  const remaining = remainingPhaseModules(phaseId, TOPICS, snapshot);
  if(!remaining.length) return '';
  return '<div class="project-card-copy">Unlocks with this phase\'s topics:</div><ul class="remaining-modules">' +
    remaining.map(topic=>'<li>' + escapeHtml(topic.title) + '</li>').join('') + '</ul>';
}

function renderProjectsView(){
  const container = document.getElementById('projects-content');
  if(!container) return;
  const snapshot = progressSnapshot();
  let html = PROJECTS.map(project=>{
    const record = getProjectProgress(project.id);
    const available = isProjectAvailable(project, TOPICS, snapshot);
    const status = projectStatusLabel(project, record, available);
    const locked = record.status === 'not-started' && !available;
    return '<article class="project-list-card">' +
      '<div class="project-phase">' + escapeHtml(project.phaseId.toUpperCase() + ' · ' + project.phaseTitle) + '</div>' +
      '<h3>' + escapeHtml(project.title) + '</h3>' +
      '<div class="project-status">' + escapeHtml(status) + '</div>' +
      '<div class="project-card-copy">' + escapeHtml(project.purpose) + '</div>' +
      (locked ? renderRemainingModules(project.phaseId, snapshot) : '') +
      '<button class="pomo-btn ' + (available || record.status !== 'not-started' ? 'primary' : '') +
        '" onclick="openProjectDetail(\'' + escapeHtml(project.id) + '\')">' +
        (record.status === 'not-started' ? (available ? 'Start project' : 'View project') : 'Open project') + '</button>' +
    '</article>';
  }).join('');
  html += PHASE_BOSSES.map(boss=>{
    const record = getBossProgress(boss.phaseId);
    const available = isBossAvailable(boss, TOPICS, snapshot);
    return '<article class="project-list-card">' +
      '<div class="project-phase">' + escapeHtml(boss.phaseId.toUpperCase() + ' · ' + boss.phaseTitle) + '</div>' +
      '<h3>' + escapeHtml(boss.title) + '</h3>' +
      '<div class="project-status">' + (record.passed ? 'Complete' : available ? 'Available' : 'Not available yet') + '</div>' +
      (!available && !record.passed ? renderRemainingModules(boss.phaseId, snapshot) : '') +
      '<button class="pomo-btn ' + (available ? 'primary' : '') + '" onclick="openPhaseBoss(\'' + escapeHtml(boss.phaseId) + '\')">Open boss</button>' +
    '</article>';
  }).join('');
  container.innerHTML = html;
}

function openProjectDetail(projectId){
  if(!PROJECTS_BY_ID.has(projectId)) return;
  currentProjectDetail = {kind:'project', id:projectId};
  document.getElementById('project-modal-overlay').classList.add('open');
  renderProjectDetail();
}

function openPhaseBoss(phaseId){
  if(!PHASE_BOSSES_BY_ID.has(phaseId)) return;
  currentProjectDetail = {kind:'phase-boss', id:phaseId};
  document.getElementById('project-modal-overlay').classList.add('open');
  renderProjectDetail();
}

function closeProjectDetail(){
  document.getElementById('project-modal-overlay').classList.remove('open');
  currentProjectDetail = null;
  setNavigationActive(activeAppView);
}

function renderProjectDetail(){
  if(!currentProjectDetail) return;
  if(currentProjectDetail.kind === 'phase-boss') renderPhaseBossDetail(currentProjectDetail.id);
  else renderProjectDetailBody(currentProjectDetail.id);
}

function renderProjectDetailBody(projectId){
  const project = PROJECTS_BY_ID.get(projectId);
  const record = getProjectProgress(projectId);
  if(!project || !record) return;
  document.getElementById('project-modal-title').textContent = project.title;
  const root = document.getElementById('project-modal-root');
  const snapshot = progressSnapshot();
  const available = isProjectAvailable(project, TOPICS, snapshot);
  let html = '<div class="project-phase">' + escapeHtml(project.phaseId.toUpperCase() + ' · ' + project.phaseTitle) + '</div>' +
    '<div class="project-card-copy">' + escapeHtml(project.purpose) + '</div>' +
    '<div class="project-gate"><strong>Build</strong><div class="artifact-note">' + escapeHtml(project.build) + '</div></div>';
  if(record.status === 'not-started'){
    if(!available) html += renderRemainingModules(project.phaseId, snapshot);
    html += '<button class="pomo-btn primary" onclick="startProject(\'' + escapeHtml(project.id) + '\')">' +
      (available ? 'Start project' : 'Start early') + '</button>';
    root.innerHTML = html;
    return;
  }
  if(record.blocked.isBlocked){
    html += '<div class="blocked-panel"><div class="tcard-title">Blocked</div>' +
      '<div class="artifact-note">' + escapeHtml(record.blocked.reason) + '</div>' +
      '<button class="pomo-btn" style="margin-top:10px" onclick="setProjectBlocked(\'' + escapeHtml(project.id) + '\',false)">Unblocked now</button></div>';
    root.innerHTML = html;
    return;
  }
  html += '<div class="project-milestones">' + project.milestones.map((milestone,index)=>{
    const completed = record.milestones.find(item=>item.index === index);
    if(completed){
      return '<details class="project-milestone"><summary>' + escapeHtml((index + 1) + '. ' + milestone) + '</summary>' +
        '<div class="artifact-note">' + escapeHtml(completed.artifactNote) + '</div></details>';
    }
    if(index === record.currentMilestoneIndex){
      return '<div class="project-milestone current"><div class="loop-eyebrow">Current milestone</div>' +
        '<div class="loop-title">' + escapeHtml((index + 1) + '. ' + milestone) + '</div>' +
        '<div class="loop-field"><label for="project-artifact-note">What did this milestone produce?</label>' +
        '<input class="loop-input" id="project-artifact-note" type="text"></div>' +
        '<div class="loop-field"><label for="project-next-action">Shrunk next action</label>' +
        '<input class="loop-input" id="project-next-action" type="text" value="' + escapeHtml(record.nextAction || milestone) + '"></div>' +
        '<div class="loop-actions"><button class="pomo-btn primary" onclick="submitProjectMilestone()">Complete milestone</button>' +
        '<button class="pomo-btn" onclick="saveProjectNextAction()">Save next action</button></div>' +
        '<div class="loop-field"><label for="project-block-reason">Blocked reason</label>' +
        '<input class="loop-input" id="project-block-reason" type="text" placeholder="What is preventing the next step?"></div>' +
        '<button class="pomo-btn" onclick="blockOpenProject()">Mark blocked</button><div class="loop-error" id="project-error"></div></div>';
    }
    return '<div class="project-milestone future">' + escapeHtml((index + 1) + '. ' + milestone) + '</div>';
  }).join('') + '</div>';
  if(record.currentMilestoneIndex >= project.milestones.length && record.status !== 'complete'){
    html += renderProjectCompletionFlow(project, record);
  }
  if(record.status === 'complete'){
    html += '<div class="project-gate"><strong>Project complete</strong><div class="artifact-note">' + escapeHtml(record.postmortem) + '</div></div>';
  }
  root.innerHTML = html;
}

function renderProjectCompletionFlow(project, record){
  let html = '<div class="project-gate"><div class="tcard-title">Pass gate</div><div class="artifact-note">' + escapeHtml(project.passGate) + '</div></div>';
  if(!record.boss.passed){
    if(record.boss.attempted) html += '<div class="project-card-copy">Boss not passed yet.</div>';
    html += '<div class="project-milestone current"><div class="loop-eyebrow">Boss challenge</div>' +
      '<div class="loop-copy">' + escapeHtml(project.bossChallenge) + '</div>' +
      '<label class="project-deep-option"><input id="project-pass-gate" type="checkbox"> This project meets the pass gate above.</label>' +
      '<div class="loop-field"><label for="project-boss-notes">What happened?</label><textarea class="loop-input" id="project-boss-notes"></textarea></div>' +
      '<div class="loop-radio-row"><label class="loop-radio"><input type="radio" name="project-boss-result" value="pass"> Passed</label>' +
      '<label class="loop-radio"><input type="radio" name="project-boss-result" value="fail"> Not passed yet</label></div>' +
      '<button class="pomo-btn primary" onclick="submitProjectBoss()">Record attempt</button><div class="loop-error" id="project-error"></div></div>';
    return html;
  }
  html += '<div class="project-milestone current"><div class="loop-eyebrow">Postmortem</div>' +
    '<div class="loop-copy">What failed, what changed, and what remains?</div>' +
    '<textarea class="loop-input" id="project-postmortem">' + escapeHtml(record.postmortem || '') + '</textarea>' +
    '<button class="pomo-btn primary" onclick="submitProjectPostmortem()">Complete project</button><div class="loop-error" id="project-error"></div></div>';
  return html;
}

function projectError(message){
  const el = document.getElementById('project-error');
  if(el) el.textContent = message;
}

function submitProjectMilestone(){
  if(!currentProjectDetail || currentProjectDetail.kind !== 'project') return;
  try{ completeProjectMilestone(currentProjectDetail.id, document.getElementById('project-artifact-note').value); }
  catch(error){ projectError(error.message); }
}

function saveProjectNextAction(){
  if(!currentProjectDetail || currentProjectDetail.kind !== 'project') return;
  updateProjectNextAction(currentProjectDetail.id, document.getElementById('project-next-action').value);
}

function blockOpenProject(){
  if(!currentProjectDetail || currentProjectDetail.kind !== 'project') return;
  try{ setProjectBlocked(currentProjectDetail.id, true, document.getElementById('project-block-reason').value); }
  catch(error){ projectError(error.message); }
}

function submitProjectBoss(){
  if(!currentProjectDetail || currentProjectDetail.kind !== 'project') return;
  const gate = document.getElementById('project-pass-gate');
  const selected = document.querySelector('input[name="project-boss-result"]:checked');
  if(!gate || !gate.checked){ projectError('Confirm the pass-gate self-check first.'); return; }
  if(!selected){ projectError('Record whether the challenge passed.'); return; }
  try{ recordProjectBossAttempt(currentProjectDetail.id, selected.value === 'pass', document.getElementById('project-boss-notes').value); }
  catch(error){ projectError(error.message); }
}

function submitProjectPostmortem(){
  if(!currentProjectDetail || currentProjectDetail.kind !== 'project') return;
  try{ completeProjectPostmortem(currentProjectDetail.id, document.getElementById('project-postmortem').value); }
  catch(error){ projectError(error.message); }
}

function renderPhaseBossDetail(phaseId){
  const boss = PHASE_BOSSES_BY_ID.get(phaseId);
  const record = getBossProgress(phaseId);
  if(!boss || !record) return;
  document.getElementById('project-modal-title').textContent = boss.title;
  const root = document.getElementById('project-modal-root');
  const snapshot = progressSnapshot();
  const available = isBossAvailable(boss, TOPICS, snapshot);
  let html = '<div class="project-phase">' + escapeHtml(boss.phaseId.toUpperCase() + ' · ' + boss.phaseTitle) + '</div>' +
    '<div class="project-gate"><strong>Build</strong><div class="artifact-note">' + escapeHtml(boss.build) + '</div></div>' +
    '<div class="project-gate"><strong>Challenge</strong><div class="artifact-note">' + escapeHtml(boss.challenge) + '</div></div>' +
    '<div class="project-gate"><strong>Pass gate</strong><div class="artifact-note">' + escapeHtml(boss.passGate) + '</div></div>';
  if(record.passed){
    html += '<div class="project-card-copy">Complete</div><div class="artifact-note">' + escapeHtml(record.notes) + '</div>';
  } else if(!available){
    html += renderRemainingModules(phaseId, snapshot);
  } else {
    if(record.notes) html += '<div class="project-card-copy">Boss not passed yet.</div>';
    html += '<div class="loop-field"><label for="phase-boss-notes">What happened?</label><textarea class="loop-input" id="phase-boss-notes"></textarea></div>' +
      '<div class="loop-radio-row"><label class="loop-radio"><input type="radio" name="phase-boss-result" value="pass"> Passed</label>' +
      '<label class="loop-radio"><input type="radio" name="phase-boss-result" value="fail"> Not passed yet</label></div>' +
      '<button class="pomo-btn primary" onclick="submitPhaseBoss()">Record attempt</button><div class="loop-error" id="project-error"></div>';
  }
  root.innerHTML = html;
}

function submitPhaseBoss(){
  if(!currentProjectDetail || currentProjectDetail.kind !== 'phase-boss') return;
  const selected = document.querySelector('input[name="phase-boss-result"]:checked');
  if(!selected){ projectError('Record whether the challenge passed.'); return; }
  try{ recordPhaseBossAttempt(currentProjectDetail.id, selected.value === 'pass', document.getElementById('phase-boss-notes').value); }
  catch(error){ projectError(error.message); }
}

function updateStats(){
  const total = TOPICS.length;
  let started=0, handsOnDone=0, complete=0;
  TOPICS.forEach(t=>{
    const l = levelOf(t.id);
    if(l>=1) started++;
    if(l===3) complete++;
    handsOnDone += getTopicProgress(t.id).handsOnDone.filter(Boolean).length;
  });
  document.getElementById('s-total').textContent = total;
  document.getElementById('s-defined').textContent = started;
  document.getElementById('s-explain').textContent = handsOnDone;
  document.getElementById('s-mastered').textContent = complete;

  const coreTopics = TOPICS.filter(t=>!t.secondary);
  const extendedTopics = TOPICS.filter(t=>t.secondary);
  const masteredCore = coreTopics.filter(t=>levelOf(t.id)===3).length;
  const masteredExtended = extendedTopics.filter(t=>levelOf(t.id)===3).length;
  const coreReadiness = coreTopics.length ? Math.round(masteredCore/coreTopics.length*100) : 0;
  const extReadiness = extendedTopics.length ? Math.round(masteredExtended/extendedTopics.length*100) : 0;

  // Progress bar tracks core-path mastery only — Extended topics are bonus,
  // not required, so they shouldn't make you look less ready by diluting it.
  document.getElementById('pbar').style.width = coreReadiness+'%';
  document.getElementById('readiness-line').textContent =
    `Core readiness: ${coreReadiness}%  ·  Extended: ${extReadiness}%`;

  buildPhaseNav(); // refresh per-phase progress counts in the sidebar
}

function buildPhaseNav(){
  const container = document.getElementById('phase-nav-list');
  if(!container) return;
  const phases = PHASE_ORDER.filter(p=>TOPICS.some(t=>t.phase===p));
  let html = `<button class="phase-nav-item ${activePhase==='all'?'active':''}" onclick="setPhaseNav('all')">
    <div class="pn-top"><span class="pn-code">All phases</span></div>
  </button>`;
  phases.forEach(p=>{
    const items = TOPICS.filter(t=>t.phase===p);
    const mastered = items.filter(t=>levelOf(t.id)===3).length;
    const code = p.split('—')[0].trim();
    const name = p.includes('—') ? p.split('—')[1].trim() : '';
    const safe = p.replace(/'/g,"\\'");
    html += `<button class="phase-nav-item ${activePhase===p?'active':''}" onclick="setPhaseNav('${safe}')">
      <div class="pn-top"><span class="pn-code">${code}</span><span class="pn-progress">${mastered}/${items.length}</span></div>
      <div class="pn-name">${name}</div>
    </button>`;
  });
  container.innerHTML = html;
}

function setPhaseNav(phase){
  activePhase = phase;
  buildPhaseNav();
  applyFilters();
  const coll = document.getElementById('mobile-collapsible');
  if(coll){
    coll.classList.remove('collapsed');
    if(window.innerWidth <= 1024) coll.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

function collapseMobileTopics(){
  const coll = document.getElementById('mobile-collapsible');
  if(coll) coll.classList.add('collapsed');
  const nav = document.querySelector('.leftnav');
  if(nav) nav.scrollIntoView({behavior:'smooth'});
}
function setStatusFilter(val, btn){
  activeStatus=val;
  btn.parentElement.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}

let currentModalTopicId = null;
function openTopicModal(id){
  currentModalTopicId = id;
  const t = TOPICS_BY_ID.get(id);
  if(!t) return;
  document.getElementById('modal-topic-title').textContent = t.title;
  const qtag = t.q ? '<span class="qtag">' + escapeHtml(t.q) + '</span>' : '';
  const skilltag = t.skill ? '<span class="skilltag">' + escapeHtml(t.skill) + '</span>' : '';
  const extTag = t.secondary ? '<span class="extended-tag">Extended — come back to this after the core path</span>' : '';
  document.getElementById('modal-topic-tags').innerHTML = qtag + skilltag + extTag;
  renderTopicChecklist();
  renderFocusUI();
  document.getElementById('topic-modal-overlay').classList.add('open');
}

function escapeHtml(value){
  return String(value == null ? '' : value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function conceptChunkHtml(chunk){
  const items = Array.isArray(chunk) ? chunk : [chunk];
  return '<div class="loop-chunk"><ul>' +
    items.map(item=>'<li>' + escapeHtml(item) + '</li>').join('') +
    '</ul></div>';
}

// Every checkbox writes straight to localStorage the moment it's toggled —
// no in-memory draft/session layer, so there's nothing to lose by closing
// the modal or reloading mid-topic.
function renderTopicChecklist(){
  const container = document.getElementById('modal-loop');
  const t = TOPICS_BY_ID.get(currentModalTopicId);
  if(!container || !t) return;
  const progress = getTopicProgress(t.id);
  const chunks = Array.isArray(t.conceptChunks) && t.conceptChunks.length ? t.conceptChunks : [[]];
  const handsOn = Array.isArray(t.handsOn) ? t.handsOn : [];
  const complete = isTopicComplete(progress, t);
  const chunksDone = progress.chunksRead.filter(Boolean).length;
  const handsOnDone = progress.handsOnDone.filter(Boolean).length;

  let html = '<div class="loop-shell">';
  if(t.firstAction){
    html += '<div class="loop-panel"><div class="tcard-title">First move</div><div class="loop-copy">' +
      escapeHtml(t.firstAction) + '</div></div>';
  }
  html += '<div class="loop-status">' +
    '<div class="loop-step-count">' + chunksDone + '/' + chunks.length + ' chunks read &middot; ' +
      handsOnDone + '/' + chunks.length + ' hands-on done</div>' +
  '</div>';

  chunks.forEach((chunk, i)=>{
    html += '<div class="loop-panel">' +
      '<div class="loop-step-count">Chunk ' + (i + 1) + ' of ' + chunks.length + '</div>' +
      conceptChunkHtml(chunk) +
      '<label class="verify-check"><input type="checkbox" ' + (progress.chunksRead[i] ? 'checked' : '') +
        ' onchange="toggleChunkRead(\'' + t.id + '\',' + i + ',this.checked)"> Read and understood</label>';
    if(handsOn[i]){
      html += '<div class="loop-chunk"><div class="tcard-title">Hands-on</div><div class="loop-copy">' +
          escapeHtml(handsOn[i]) + '</div></div>' +
        '<label class="verify-check"><input type="checkbox" ' + (progress.handsOnDone[i] ? 'checked' : '') +
          ' onchange="toggleHandsOnDone(\'' + t.id + '\',' + i + ',this.checked)"> Hands-on done</label>';
    }
    html += '</div>';
  });

  if(t.masteryGate){
    html += '<div class="loop-panel"><div class="tcard-title">You will know it has sunk in when</div>' +
      '<div class="loop-copy">' + escapeHtml(t.masteryGate) + '</div></div>';
  }
  if(complete){
    const next = nextIncompleteTopicAfter(t.id);
    html += '<div class="loop-panel"><div class="loop-title">Topic complete</div>' +
      '<div class="loop-copy">Nice. Talk it through with your AI TA if you want it verified for real.</div>' +
      '<div class="loop-actions" style="margin-top:12px">' +
        (next
          ? '<button class="pomo-btn primary" onclick="openNextTopic()">Next: ' + escapeHtml(next.title) + '</button>'
          : '<button class="pomo-btn primary" onclick="closeTopicModal();showAppView(\'today\')">Back to Today</button>') +
      '</div></div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

// Strictly the next topic after this one in curriculum order — distinct
// from pickNextAction's Today-dashboard suggestion, which may prioritize
// resuming a different in-progress topic instead.
function nextIncompleteTopicAfter(topicId){
  const ordered = [...TOPICS].sort((a,b)=>
    a.phaseOrder - b.phaseOrder || a.moduleOrder - b.moduleOrder || a.id.localeCompare(b.id)
  );
  const idx = ordered.findIndex(item=>item.id === topicId);
  if(idx === -1) return null;
  for(let i = idx + 1; i < ordered.length; i++){
    if(!isTopicComplete(getTopicProgress(ordered[i].id), ordered[i])) return ordered[i];
  }
  return null;
}

function openNextTopic(){
  const next = nextIncompleteTopicAfter(currentModalTopicId);
  if(next) openTopicModal(next.id);
  else { closeTopicModal(); showAppView('today'); }
}

function toggleChunkRead(topicId, index, checked){
  const t = TOPICS_BY_ID.get(topicId);
  const record = getTopicProgress(topicId);
  const wasComplete = isTopicComplete(record, t);
  record.chunksRead[index] = checked;
  const now = new Date().toISOString();
  record.lastStudiedAt = now;
  const day = localDayKey(now);
  if(day && !record.activityDates.includes(day)) record.activityDates.push(day);
  saveProgressRecord(record);
  if(checked) grantXP('chunk-read', topicId + ':chunk:' + index, {timestamp:now, topicId:topicId});
  markAppActivity(topicId, now);
  finalizeTopicProgressChange(topicId, wasComplete);
}

function toggleHandsOnDone(topicId, index, checked){
  const t = TOPICS_BY_ID.get(topicId);
  const record = getTopicProgress(topicId);
  const wasComplete = isTopicComplete(record, t);
  record.handsOnDone[index] = checked;
  const now = new Date().toISOString();
  record.lastStudiedAt = now;
  const day = localDayKey(now);
  if(day && !record.activityDates.includes(day)) record.activityDates.push(day);
  saveProgressRecord(record);
  if(checked) grantXP('handson-done', topicId + ':handson:' + index, {timestamp:now, topicId:topicId});
  markAppActivity(topicId, now);
  finalizeTopicProgressChange(topicId, wasComplete);
}

function finalizeTopicProgressChange(topicId, wasComplete){
  const t = TOPICS_BY_ID.get(topicId);
  const record = getTopicProgress(topicId);
  const nowComplete = isTopicComplete(record, t);
  if(nowComplete && !wasComplete){
    record.completedAt = new Date().toISOString();
    saveProgressRecord(record);
    grantXP('topic-complete', topicId + ':complete', {timestamp:record.completedAt, topicId:topicId});
    grantComebackXPIfPending(record.completedAt);
  } else if(!nowComplete && wasComplete){
    record.completedAt = null;
    saveProgressRecord(record);
  }
  if(currentModalTopicId === topicId) renderTopicChecklist();
  renderTopicCard(topicId);
  updateStats();
  applyFilters();
  if(activeAppView === 'today') renderTodayDashboard();
  pushCloudState();
}

function closeTopicModal(){
  document.getElementById('topic-modal-overlay').classList.remove('open');
  currentModalTopicId = null;
  setNavigationActive(activeAppView);
  if(activeAppView === 'today') renderTodayDashboard();
}

function renderTopicCard(id){
  const lvl = levelOf(id);
  const ring = document.getElementById('ring'+id);
  const titleEl = document.getElementById('title'+id);
  const card = document.getElementById('card'+id);
  ring.setAttribute('data-lvl', lvl);
  ring.textContent = lvl>=1 ? (lvl===3?'✓':lvl) : '';
  titleEl.classList.toggle('mastered', lvl===3);
  card.classList.toggle('mastered', lvl===3);
}

function render(){
  buildPhaseNav();
  const container = document.getElementById('topics-container');
  container.innerHTML='';
  const phases = PHASE_ORDER.filter(p=>TOPICS.some(t=>t.phase===p));
  phases.forEach(phaseName=>{
    const items = TOPICS.filter(t=>t.phase===phaseName);
    const group = document.createElement('div');
    group.className='phase-group';
    group.setAttribute('data-phase', phaseName);
    const header=document.createElement('div');
    header.className='phase-header';
    const safePhase = phaseName.replace(/'/g,"\\'");
    header.innerHTML = `<span>${phaseName} <span class="pcount">(${items.length})</span></span><button class="quiz-phase-btn" id="${quizBtnId(phaseName)}" onclick="event.stopPropagation();openQuiz('${safePhase}')">Phase check</button>`;
    group.appendChild(header);

    const projectText = PHASE_PROJECTS[phaseName];
    if(projectText){
      const proj = document.createElement('div');
      proj.className='phase-project';
      proj.innerHTML = `<div class="plabel">Mini-project for this phase</div><p>${projectText}</p>`;
      group.appendChild(proj);
    }

    items.forEach(t=>{
      const card=document.createElement('div');
      card.className='topic-card';
      card.id='card'+t.id;
      card.setAttribute('data-title', t.title.toLowerCase());
      card.setAttribute('data-desc', t.desc.toLowerCase());

      const qtag = t.q ? `<span class="qtag">${t.q}</span>` : '';
      const skilltag = t.skill ? `<span class="skilltag">${t.skill}</span>` : '';
      const extTag = t.secondary ? `<span class="extended-tag">Extended</span>` : '';
      if(t.secondary) card.setAttribute('data-secondary', 'true');

      card.innerHTML = `
        <div class="topic-header" onclick="openTopicModal('${t.id}')">
          <div class="ring" id="ring${t.id}" data-lvl="0"></div>
          <div class="topic-title" id="title${t.id}">${t.title}</div>
          ${qtag}${skilltag}${extTag}
          <span class="chev">&#8250;</span>
        </div>`;
      group.appendChild(card);
    });
    container.appendChild(group);
  });
  TOPICS.forEach(t=>renderTopicCard(t.id));
  updateStats();
  applyFilters();
}

function applyFilters(){
  const q = document.getElementById('search').value.toLowerCase();
  let anyVisible = false;
  document.querySelectorAll('.phase-group').forEach(group=>{
    const phaseName = group.getAttribute('data-phase');
    const phaseMatch = activePhase==='all' || phaseName===activePhase;
    let groupHasVisible = false;
    group.querySelectorAll('.topic-card').forEach(card=>{
      const id = card.id.replace('card','');
      const lvl = levelOf(id);
      const statusMatch = activeStatus==='all'
        || (activeStatus==='todo' && lvl===0)
        || (activeStatus==='progress' && lvl>0 && lvl<3)
        || (activeStatus==='mastered' && lvl===3);
      const searchMatch = !q || card.getAttribute('data-title').includes(q) || card.getAttribute('data-desc').includes(q);
      const coreMatch = !showCoreOnly || card.getAttribute('data-secondary') !== 'true';
      const show = phaseMatch && statusMatch && searchMatch && coreMatch;
      card.classList.toggle('hidden', !show);
      if(show){groupHasVisible=true; anyVisible=true;}
    });
    group.style.display = groupHasVisible ? 'block' : 'none';
  });
  let noResults = document.getElementById('no-results');
  if(!anyVisible){
    if(!noResults){
      noResults=document.createElement('div');
      noResults.id='no-results';
      noResults.className='no-results';
      noResults.textContent='No topics match.';
      document.getElementById('topics-container').appendChild(noResults);
    }
    noResults.style.display='block';
  } else if(noResults){ noResults.style.display='none'; }
}

// ===== Daily log (today's minutes + completed topics) =====
function todayStr(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
let dailyLog = {minutes:0, completedIds:[]};
function saveDailyLog(){
  localStorage.setItem('fnd-daily-log:'+todayStr(), JSON.stringify(dailyLog));
}

let quizResults = {};
function saveQuizResults(){
  localStorage.setItem('fnd-quiz-results', JSON.stringify(quizResults));
  pushCloudState();
}

function openDailyLogModal(){
  const body = document.getElementById('daily-modal-body');
  body.innerHTML = TOPICS.map(t=>`
    <label class="daily-check">
      <input type="checkbox" ${dailyLog.completedIds.includes(t.id)?'checked':''} onchange="toggleDailyComplete('${t.id}', this.checked)">
      ${t.title}
    </label>`).join('');
  const btn = document.getElementById('modal-save-btn');
  btn.textContent = 'Save';
  btn.classList.remove('saved');
  document.getElementById('daily-modal-overlay').classList.add('open');
}
function toggleDailyComplete(id, checked){
  if(checked){
    if(!dailyLog.completedIds.includes(id)) dailyLog.completedIds.push(id);
  } else {
    dailyLog.completedIds = dailyLog.completedIds.filter(x=>x!==id);
  }
}
function closeModal(){
  document.getElementById('daily-modal-overlay').classList.remove('open');
}
function saveModalProgress(){
  saveDailyLog();
  const btn = document.getElementById('modal-save-btn');
  btn.textContent = 'Saved ✓';
  btn.classList.add('saved');
  showToast('Progress saved');
  drawRings();
  setTimeout(closeModal, 700);
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 1800);
}

// ===== Focus session (notice-and-return) =====
// Replaces the old Pomodoro. The unit of value is not unbroken minutes —
// it's noticing drift and returning without self-attack. The "I drifted"
// button IS the rep: tapping it means attention already came back. Hard
// rules from the spec: no live drift count, no escalating/warning styling
// no matter how many taps, and the timer never pauses or penalizes a tap.
// Keeps the old absolute-end-timestamp countdown so backgrounded tabs
// stay accurate.

const FOCUS_DURATIONS = [15, 20, 25];

let focusPrefs = {defaultMinutes: 20, suggestSuppressedUntil: null};
function loadFocusPrefs(){
  try{
    const raw = localStorage.getItem('focusPrefs');
    if(raw){
      const parsed = JSON.parse(raw);
      if(FOCUS_DURATIONS.includes(parsed.defaultMinutes)) focusPrefs.defaultMinutes = parsed.defaultMinutes;
      focusPrefs.suggestSuppressedUntil = parsed.suggestSuppressedUntil || null;
    }
  } catch(e){}
}
function saveFocusPrefs(){
  localStorage.setItem('focusPrefs', JSON.stringify(focusPrefs));
  pushCloudState();
}

// Append-only session log. Same swappable-boundary pattern as the other
// stores: these are the only functions that touch the `sessions` key.
function getSessions(){
  try{
    const raw = localStorage.getItem('sessions');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch(e){ return []; }
}
function saveSessions(list){
  localStorage.setItem('sessions', JSON.stringify(list));
}
function appendSessionRecord(record){
  const list = getSessions();
  list.push(record);
  saveSessions(list);
  pushCloudState();
}
function updateSessionRecord(id, patch){
  const list = getSessions();
  const idx = list.findIndex(s=>s.id === id);
  if(idx < 0) return;
  Object.assign(list[idx], patch);
  saveSessions(list);
  pushCloudState();
}

function newSessionId(){
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Momentum hook: a completed session counts the day as active for the
// Today view's dots, in addition to evidence entries already counting.
function sessionActiveDayKeys(){
  const days = new Set();
  getSessions().forEach(s=>{
    if(s.endedEarly) return;
    const key = localDayKey(s.endedAt);
    if(key) days.add(key);
  });
  return days;
}

let focusSession = null;   // {id, topicId, plannedMinutes, startedAt, endTime, remainingSec, running, timerId, noticeReturns[]}
let focusEndFlow = null;   // {sessionId, topicId, minutes, catches, step:'outcome'|'resume'|'break'}
let focusBreak = null;     // {endTime, timerId}
let driftAckTimer = null;

function focusBoundTopicId(){
  if(currentModalTopicId) return currentModalTopicId;
  if(!currentTodayAction) currentTodayAction = buildTodayAction();
  return currentTodayAction.topicId || null;
}

function startFocusSession(topicId){
  if(focusSession || focusBreak) return;
  if(!topicId) return;
  focusEndFlow = null;
  focusSession = {
    id: newSessionId(),
    topicId: topicId,
    plannedMinutes: focusPrefs.defaultMinutes,
    startedAt: new Date().toISOString(),
    remainingSec: focusPrefs.defaultMinutes * 60,
    endTime: Date.now() + focusPrefs.defaultMinutes * 60 * 1000,
    running: true,
    timerId: setInterval(focusTick, 1000),
    noticeReturns: []
  };
  renderFocusUI();
}

// Starting the recommended task and starting a block are one motion.
function startFocusFromToday(){
  const topicId = focusBoundTopicId();
  if(!topicId) return;
  comebackPending = false;
  openTopicModal(topicId);
  startFocusSession(topicId);
}

function focusTick(){
  if(!focusSession || !focusSession.running) return;
  focusSession.remainingSec = Math.max(0, Math.round((focusSession.endTime - Date.now()) / 1000));
  if(focusSession.remainingSec <= 0){
    finishFocusSession(false);
    return;
  }
  updateFocusCountdown();
}

function focusPauseToggle(){
  if(!focusSession) return;
  if(focusSession.running){
    clearInterval(focusSession.timerId);
    focusSession.timerId = null;
    focusSession.running = false;
  } else {
    focusSession.running = true;
    focusSession.endTime = Date.now() + focusSession.remainingSec * 1000;
    focusSession.timerId = setInterval(focusTick, 1000);
  }
  renderFocusUI();
}

// The tap is the rep: noticing + tapping means attention already returned.
// Identical acknowledgement every time, no count shown, timer untouched.
function driftTap(){
  if(!focusSession) return;
  focusSession.noticeReturns.push(new Date().toISOString());
  document.querySelectorAll('.drift-ack').forEach(el=>{ el.textContent = 'Noted. Back to it.'; });
  if(driftAckTimer) clearTimeout(driftAckTimer);
  driftAckTimer = setTimeout(()=>{
    document.querySelectorAll('.drift-ack').forEach(el=>{ el.textContent = ''; });
  }, 2000);
}

function endFocusEarly(){
  finishFocusSession(true);
}

// One path for both outcomes — an ended-early block records endedEarly:true
// and nothing else different. Same end screen, same tone.
function finishFocusSession(endedEarly){
  if(!focusSession) return;
  clearInterval(focusSession.timerId);
  const workedSec = focusSession.plannedMinutes * 60 - focusSession.remainingSec;
  const actualMinutes = endedEarly ? Math.max(1, Math.round(workedSec / 60)) : focusSession.plannedMinutes;
  const record = {
    id: focusSession.id,
    startedAt: focusSession.startedAt,
    endedAt: new Date().toISOString(),
    plannedMinutes: focusSession.plannedMinutes,
    actualMinutes: actualMinutes,
    topicId: focusSession.topicId,
    noticeReturns: focusSession.noticeReturns.slice(),
    endedEarly: !!endedEarly,
    outcomeNote: null
  };
  appendSessionRecord(record);
  if(!record.endedEarly){
    grantXP('focus-block', 'session:' + record.id, {timestamp:record.endedAt,refType:'session',topicId:record.topicId});
  }
  dailyLog.minutes += actualMinutes;
  saveDailyLog();
  drawRings();
  focusEndFlow = {
    sessionId: record.id,
    topicId: record.topicId,
    startedAt: record.startedAt,
    minutes: actualMinutes,
    catches: record.noticeReturns.length,
    step: 'outcome'
  };
  focusSession = null;
  renderFocusUI();
  const outcomeInput = document.getElementById('focus-outcome-input');
  if(outcomeInput) outcomeInput.focus();
  if(activeAppView === 'today') renderTodayDashboard();
}

function submitFocusOutcome(){
  if(!focusEndFlow) return;
  const input = document.getElementById('focus-outcome-input');
  const text = input ? input.value.trim() : '';
  if(text) updateSessionRecord(focusEndFlow.sessionId, {outcomeNote: text});
  advanceFocusEndFlow();
}

function skipFocusOutcome(){
  advanceFocusEndFlow();
}

function advanceFocusEndFlow(){
  if(!focusEndFlow) return;
  if(focusEndFlow.step === 'outcome'){
    focusEndFlow.step = 'break';
  }
  renderFocusUI();
}

function startFocusBreak(){
  focusEndFlow = null;
  focusBreak = {
    endTime: Date.now() + 5 * 60 * 1000,
    remainingSec: 5 * 60,
    timerId: setInterval(focusBreakTick, 1000)
  };
  renderFocusUI();
}

function focusBreakTick(){
  if(!focusBreak) return;
  focusBreak.remainingSec = Math.max(0, Math.round((focusBreak.endTime - Date.now()) / 1000));
  if(focusBreak.remainingSec <= 0){
    clearInterval(focusBreak.timerId);
    focusBreak = null;
    showToast('Break over — ready for another round');
    renderFocusUI();
    return;
  }
  updateFocusCountdown();
}

function dismissFocusEndFlow(){
  focusEndFlow = null;
  renderFocusUI();
}

function setFocusDuration(minutes){
  if(!FOCUS_DURATIONS.includes(minutes)) return;
  focusPrefs.defaultMinutes = minutes;
  saveFocusPrefs();
  renderFocusUI();
}

// After 5 completed blocks at the current length within 7 days, one gentle
// nudge to try +5. Never automatic, never past 25, never a nudge downward.
function getProgressionSuggestion(){
  if(focusPrefs.defaultMinutes >= 25) return null;
  if(focusPrefs.suggestSuppressedUntil && Date.now() < new Date(focusPrefs.suggestSuppressedUntil).getTime()) return null;
  const atLength = getSessions()
    .filter(s=>s.plannedMinutes === focusPrefs.defaultMinutes)
    .sort((a,b)=>new Date(b.endedAt) - new Date(a.endedAt))
    .slice(0, 5);
  if(atLength.length < 5) return null;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const allGood = atLength.every(s=>!s.endedEarly && new Date(s.endedAt).getTime() >= weekAgo);
  if(!allGood) return null;
  return {from: focusPrefs.defaultMinutes, to: focusPrefs.defaultMinutes + 5};
}

function acceptProgressionSuggestion(){
  const suggestion = getProgressionSuggestion();
  if(suggestion) setFocusDuration(suggestion.to);
}

function deferProgressionSuggestion(){
  focusPrefs.suggestSuppressedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  saveFocusPrefs();
  renderFocusUI();
}

function formatCountdown(totalSec){
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return m + ':' + s;
}

function updateFocusCountdown(){
  const value = focusSession ? formatCountdown(focusSession.remainingSec)
    : focusBreak ? formatCountdown(focusBreak.remainingSec) : null;
  if(value == null) return;
  document.querySelectorAll('.focus-countdown').forEach(el=>{ el.textContent = value; });
}

function focusTopicTitle(topicId){
  const t = TOPICS_BY_ID.get(topicId);
  return t ? t.title : '';
}

function renderFocusCardHTML(surface){
  if(focusSession){
    return '<div class="focus-card">' +
      '<div class="focus-topic-label">' + escapeHtml(focusTopicTitle(focusSession.topicId)) + '</div>' +
      '<div class="pomo-display focus-countdown" style="font-size:30px">' + formatCountdown(focusSession.remainingSec) + '</div>' +
      '<button class="drift-btn" onclick="driftTap()">I drifted</button>' +
      '<div class="drift-ack"></div>' +
      '<div class="focus-secondary">' +
        '<button class="pomo-btn" onclick="focusPauseToggle()">' + (focusSession.running ? 'Pause' : 'Resume') + '</button>' +
        '<button class="pomo-btn" onclick="endFocusEarly()">End early</button>' +
      '</div>' +
    '</div>';
  }
  if(focusBreak){
    return '<div class="focus-card">' +
      '<div class="focus-topic-label">Break</div>' +
      '<div class="pomo-display focus-countdown" style="font-size:30px">' + formatCountdown(focusBreak.remainingSec) + '</div>' +
    '</div>';
  }
  if(focusEndFlow){
    const catchesLine = focusEndFlow.catches > 0
      ? '<div class="focus-summary">' + focusEndFlow.catches + ' catch' + (focusEndFlow.catches === 1 ? '' : 'es') + ' and returns</div>'
      : '';
    let body = '<div class="focus-summary">' + focusEndFlow.minutes + ' minutes on ' +
      escapeHtml(focusTopicTitle(focusEndFlow.topicId)) + '</div>' + catchesLine;
    if(focusEndFlow.step === 'outcome'){
      body += '<div class="focus-end-form">' +
        '<label for="focus-outcome-input">What did you get done?</label>' +
        '<textarea class="focus-input" id="focus-outcome-input"></textarea>' +
        '</div>' +
        '<div class="focus-actions">' +
          '<button class="pomo-btn primary" onclick="submitFocusOutcome()">Save</button>' +
          '<button class="pomo-btn" onclick="skipFocusOutcome()">Skip</button>' +
        '</div>';
    } else {
      body += '<div class="focus-actions">' +
        '<button class="pomo-btn primary" onclick="startFocusBreak()">Start 5-minute break</button>' +
        '<button class="pomo-btn" onclick="dismissFocusEndFlow()">Done</button>' +
      '</div>';
    }
    return '<div class="focus-card">' + body + '</div>';
  }
  // Idle: pick a length, start a block. In the topic modal the block binds
  // to the open topic; in the sidebar it binds to the recommended next task.
  const suggestion = getProgressionSuggestion();
  const suggestHtml = suggestion
    ? '<div class="focus-suggest">These ' + suggestion.from + '-minute blocks have been landing. Try ' + suggestion.to + '?' +
      '<div class="focus-actions" style="margin-top:8px">' +
        '<button class="pomo-btn primary" onclick="acceptProgressionSuggestion()">Yes</button>' +
        '<button class="pomo-btn" onclick="deferProgressionSuggestion()">Not yet</button>' +
      '</div></div>'
    : '';
  const chips = '<div class="duration-chips">' + FOCUS_DURATIONS.map(min=>
    '<button class="duration-chip ' + (min === focusPrefs.defaultMinutes ? 'active' : '') + '" onclick="setFocusDuration(' + min + ')">' + min + 'm</button>'
  ).join('') + '</div>';
  if(surface === 'modal' && currentModalTopicId){
    return '<div class="focus-card">' + suggestHtml + chips +
      '<button class="pomo-btn primary" onclick="startFocusSession(currentModalTopicId)">Start</button>' +
    '</div>';
  }
  const bindable = focusBoundTopicId();
  if(!bindable) return '<div class="focus-card"><div class="focus-topic-label">Open a topic to start a block.</div></div>';
  return '<div class="focus-card">' + suggestHtml + chips +
    '<div class="focus-topic-label">Next: ' + escapeHtml(focusTopicTitle(bindable)) + '</div>' +
    '<button class="pomo-btn primary" onclick="startFocusFromToday()">Start a focus block</button>' +
  '</div>';
}

function renderFocusUI(){
  const modalCard = document.getElementById('focus-card-modal');
  if(modalCard) modalCard.innerHTML = renderFocusCardHTML('modal');
  const sideCard = document.getElementById('focus-card-side');
  if(sideCard) sideCard.innerHTML = renderFocusCardHTML('side');
}

// ===== Activity rings =====
// NOTE: the "Python topics" vs "AI/ML topics" split was tied to the old
// curriculum's skill:"Python" tagging, which the new module schema doesn't
// carry (skill now shows depth: Light/Core/Deep instead). Left wired up as
// before rather than inventing a new split — the "Python" ring will read 0
// until this is deliberately redesigned in a later step.
function pythonCountToday(){ return dailyLog.completedIds.filter(id=>TOPICS_BY_ID.get(id) && TOPICS_BY_ID.get(id).skill==='Python').length; }
function aimlCountToday(){ return dailyLog.completedIds.filter(id=>TOPICS_BY_ID.get(id) && TOPICS_BY_ID.get(id).skill!=='Python').length; }

function drawRings(){
  const svg = document.getElementById('rings-svg');
  if(!svg) return;
  const cx=70, cy=70;
  const rings = [
    {r:60, color:'#3B76A0', prog: Math.min(dailyLog.minutes/60,1)},
    {r:44, color:'#B0473C', prog: Math.min(pythonCountToday()/2,1)},
    {r:28, color:'#4C9650', prog: Math.min(aimlCountToday()/2,1)}
  ];
  svg.innerHTML = rings.map(rg=>{
    const circ = 2*Math.PI*rg.r;
    const offset = circ*(1-rg.prog);
    return `<circle cx="${cx}" cy="${cy}" r="${rg.r}" fill="none" stroke="#E0E3DD" stroke-width="9"/>
      <circle cx="${cx}" cy="${cy}" r="${rg.r}" fill="none" stroke="${rg.color}" stroke-width="9"
        stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
        transform="rotate(-90 ${cx} ${cy})" style="transition:stroke-dashoffset .4s"/>`;
  }).join('');
}

// ===== Quizzes =====
let currentQuizQuestions = [];
let currentQuizPhase = null;
let currentQuizAnswers = [];

function getQuestionsForPhase(phaseName){
  return Object.keys(QUIZ_BANK).filter(title=>{
    const t = TOPICS.find(x=>x.title===title);
    return t && t.phase===phaseName;
  }).map(title=>QUIZ_BANK[title]);
}
function getQuestionsForToday(){
  return Object.keys(QUIZ_BANK).filter(title=>{
    const t = TOPICS.find(x=>x.title===title);
    return t && dailyLog.completedIds.includes(t.id);
  }).map(title=>QUIZ_BANK[title]);
}
function quizBtnId(phaseName){ return 'quizbtn-'+phaseName.replace(/[^a-zA-Z0-9]/g,''); }

function openQuiz(phaseName){
  const qs = getQuestionsForPhase(phaseName);
  if(qs.length===0){ showToast('No quiz available for this phase yet'); return; }
  currentQuizQuestions = qs;
  currentQuizPhase = phaseName;
  currentQuizAnswers = new Array(qs.length).fill(null);
  document.getElementById('quiz-phase-label').textContent = phaseName;
  document.getElementById('quiz-title').textContent = 'Phase check';
  renderQuizBody();
  document.getElementById('quiz-overlay').classList.add('open');
}

function openDailyQuiz(){
  const qs = getQuestionsForToday();
  if(qs.length===0){ showToast('Mark at least one topic complete today first'); return; }
  currentQuizQuestions = qs;
  currentQuizPhase = null;
  currentQuizAnswers = new Array(qs.length).fill(null);
  document.getElementById('quiz-phase-label').textContent = "Today's completed topics";
  document.getElementById('quiz-title').textContent = "Today's check-in";
  renderQuizBody();
  document.getElementById('quiz-overlay').classList.add('open');
}

function closeQuiz(){
  document.getElementById('quiz-overlay').classList.remove('open');
}

function renderQuizBody(){
  const body = document.getElementById('quiz-body');
  body.innerHTML = currentQuizQuestions.map((q,qi)=>`
    <div class="quiz-q">
      <div class="quiz-q-text">${qi+1}. ${q.q}</div>
      ${q.options.map((opt,oi)=>`<button class="quiz-opt" id="qopt-${qi}-${oi}" onclick="answerQuiz(${qi},${oi})">${opt}</button>`).join('')}
    </div>`).join('') + `<button class="pomo-btn primary" style="width:100%;margin-top:6px" onclick="submitQuiz()">Submit</button><div id="quiz-result-box"></div>`;
}

function answerQuiz(qi, oi){
  // Only marks your own pick — doesn't reveal the correct answer, so you
  // can't game a wrong guess into an immediate free hint before submitting.
  currentQuizAnswers[qi]=oi;
  document.querySelectorAll(`[id^="qopt-${qi}-"]`).forEach(btn=>btn.classList.remove('selected'));
  document.getElementById(`qopt-${qi}-${oi}`).classList.add('selected');
}

function submitQuiz(){
  const total = currentQuizQuestions.length;
  let score=0;
  currentQuizQuestions.forEach((q,qi)=>{
    if(currentQuizAnswers[qi]===q.correct) score++;
    // reveal correct/incorrect for every question only now, at submit time
    document.querySelectorAll(`[id^="qopt-${qi}-"]`).forEach(btn=>btn.classList.remove('selected'));
    document.getElementById(`qopt-${qi}-${q.correct}`).classList.add('correct');
    if(currentQuizAnswers[qi] !== null && currentQuizAnswers[qi] !== q.correct){
      document.getElementById(`qopt-${qi}-${currentQuizAnswers[qi]}`).classList.add('incorrect');
    }
  });
  const pass = (score/total) >= 0.7;
  document.getElementById('quiz-result-box').innerHTML =
    `<div class="quiz-result ${pass?'pass':'fail'}">${score}/${total} correct — ${pass?'Passed! 🎉':'Not quite — review and retry.'}</div>`;
  if(currentQuizPhase && pass){
    const wasAlreadyPassed = !!(quizResults[currentQuizPhase] && quizResults[currentQuizPhase].passed);
    quizResults[currentQuizPhase] = {passed:true, score, total};
    saveQuizResults();
    if(!wasAlreadyPassed) grantXP('quiz-passed', currentQuizPhase + ':quiz-pass', {refType:'quiz'});
    const btn = document.getElementById(quizBtnId(currentQuizPhase));
    if(btn){ btn.classList.add('passed'); btn.textContent='Phase check ✓ passed'; }
    showToast('Phase check passed!');
  }
}

function markPassedQuizButtons(){
  Object.keys(quizResults).forEach(phaseName=>{
    if(quizResults[phaseName] && quizResults[phaseName].passed){
      const btn = document.getElementById(quizBtnId(phaseName));
      if(btn){ btn.classList.add('passed'); btn.textContent='Phase check ✓ passed'; }
    }
  });
}

// ===== Optional one-way import from a public Gist =====
// This is a READ-only import, not two-way sync — it only ever pulls a
// snapshot in; nothing here ever pushes local changes back out to the Gist.
// Set GIST_RAW_URL to a raw.githubusercontent.com URL for a public gist JSON
// file to import shared state on load. Left empty by default — never put a
// GitHub token in this file, since it's served publicly from GitHub Pages.
const GIST_RAW_URL = '';
function importFromGist(){
  if(!GIST_RAW_URL) return;
  fetch(GIST_RAW_URL).then(r=>r.json()).then(data=>{
    if(data.state){ state = Object.assign({}, state, data.state); saveState(); }
    if(data.quizResults){ quizResults = Object.assign({}, quizResults, data.quizResults); saveQuizResults(); }
    render();
    markPassedQuizButtons();
    drawRings();
  }).catch(()=>{});
}

function init(){
  loadAppState();
  recomputeXPState();
  initializeComebackState();
  // Topic progress is no longer preloaded into one blob — getTopicProgress()
  // reads each topic's own `progress:{topicId}` key on demand.
  try{ const v = localStorage.getItem('fnd-daily-log:'+todayStr()); if(v) dailyLog = JSON.parse(v); }catch(e){}
  try{ const v = localStorage.getItem('fnd-quiz-results'); if(v) quizResults = JSON.parse(v); }catch(e){}
  render();
  markPassedQuizButtons();
  drawRings();
  loadFocusPrefs();
  renderFocusUI();
  showAppView('today');
  // On mobile, start collapsed to a fast, glanceable overview — the full
  // topic list only loads in once you tap a phase, since studying on a
  // phone isn't the point here, checking progress is.
  if(window.innerWidth <= 1024){
    const coll = document.getElementById('mobile-collapsible');
    if(coll) coll.classList.add('collapsed');
  }
  importFromGist(); // one-way pull of a shared snapshot, if configured, then re-render
  // Deliberately not pushing local state to the cloud here. The cloud
  // listener (module script below) delivers the real synced data shortly
  // after load — pushing local state first would race it and can overwrite
  // real cloud data with an empty/stale local copy on a fresh device. The
  // cloud doc gets seeded naturally the first time you actually change
  // something (loop evidence/quiz/verify already call pushCloudState()).
}

// ===== Real-time cross-device sync (Firestore) =====
// The actual Firebase calls live in a separate <script type="module"> below
// (module imports don't work in a classic script), which exposes
// window.__cloudSync.push(data) and calls window.applyCloudState(data) here
// whenever another device's change arrives. Both directions degrade to a
// no-op if the module hasn't loaded yet (e.g. slow network) — sync is a
// bonus layer on top of localStorage, never a requirement for the tracker
// to work.
function pushCloudState(){
  if(!window.__cloudSync) return;
  const progress = {};
  const projectProgress = {};
  const bossProgress = {};
  TOPICS.forEach(t=>{
    try{
      const raw = localStorage.getItem('progress:'+t.id);
      if(raw) progress[t.id] = JSON.parse(raw);
    } catch(e){}
  });
  PROJECTS.forEach(project=>{
    try{
      const raw = localStorage.getItem('projectProgress:' + project.id);
      if(raw) projectProgress[project.id] = JSON.parse(raw);
    } catch(e){}
  });
  PHASE_BOSSES.forEach(boss=>{
    try{
      const raw = localStorage.getItem('bossProgress:' + boss.phaseId);
      if(raw) bossProgress[boss.phaseId] = JSON.parse(raw);
    } catch(e){}
  });
  window.__cloudSync.push({
    progress, projectProgress, bossProgress, xpEvents:getXPEvents(),
    quizResults, appState, sessions:getSessions(), focusPrefs
  });
}

function applyCloudState(data){
  let changed = false;
  if(data.progress){
    Object.keys(data.progress).forEach(topicId=>{
      localStorage.setItem('progress:'+topicId, JSON.stringify(data.progress[topicId]));
    });
    changed = true;
  }
  if(data.projectProgress){
    Object.keys(data.projectProgress).forEach(projectId=>{
      if(PROJECTS_BY_ID.has(projectId)) localStorage.setItem('projectProgress:' + projectId, JSON.stringify(data.projectProgress[projectId]));
    });
    changed = true;
  }
  if(data.bossProgress){
    Object.keys(data.bossProgress).forEach(phaseId=>{
      if(PHASE_BOSSES_BY_ID.has(phaseId)) localStorage.setItem('bossProgress:' + phaseId, JSON.stringify(data.bossProgress[phaseId]));
    });
    changed = true;
  }
  if(Array.isArray(data.xpEvents)){
    const mergedXP = new Map();
    getXPEvents().forEach(event=>{ if(event && event.refId) mergedXP.set(event.refId, event); });
    data.xpEvents.forEach(event=>{ if(event && event.refId) mergedXP.set(event.refId, event); });
    saveXPEvents([...mergedXP.values()].sort((a,b)=>new Date(a.timestamp) - new Date(b.timestamp)));
    changed = true;
  }
  if(data.quizResults){ quizResults = data.quizResults; localStorage.setItem('fnd-quiz-results', JSON.stringify(quizResults)); changed = true; }
  if(data.appState){
    appState = {
      lastActiveTopicId: typeof data.appState.lastActiveTopicId === 'string' ? data.appState.lastActiveTopicId : null,
      lastActiveAt: data.appState.lastActiveAt || null,
      xpTotal: Number.isFinite(data.appState.xpTotal) ? data.appState.xpTotal : 0,
      currentRank: typeof data.appState.currentRank === 'string' ? data.appState.currentRank : null
    };
    saveAppState();
    changed = true;
  }
  if(Array.isArray(data.sessions)){
    // Sessions are an append-only log, so merge by id (local ∪ cloud) —
    // a wholesale replace could drop entries recorded on this device.
    const merged = new Map();
    getSessions().forEach(s=>{ if(s && s.id) merged.set(s.id, s); });
    data.sessions.forEach(s=>{ if(s && s.id) merged.set(s.id, s); });
    saveSessions([...merged.values()].sort((a,b)=>new Date(a.startedAt) - new Date(b.startedAt)));
    changed = true;
  }
  if(data.focusPrefs){
    if(FOCUS_DURATIONS.includes(data.focusPrefs.defaultMinutes)) focusPrefs.defaultMinutes = data.focusPrefs.defaultMinutes;
    focusPrefs.suggestSuppressedUntil = data.focusPrefs.suggestSuppressedUntil || null;
    localStorage.setItem('focusPrefs', JSON.stringify(focusPrefs));
    changed = true;
  }
  if(!changed) return;
  recomputeXPState();
  if(document.getElementById('main-wrap').style.display === 'none') return; // still on the lock screen — nothing to refresh yet
  render();
  markPassedQuizButtons();
  if(currentModalTopicId !== null){
    renderTopicChecklist();
  }
  if(activeAppView === 'today') renderTodayDashboard();
  if(activeAppView === 'projects') renderProjectsView();
  if(currentProjectDetail) renderProjectDetail();
  // Don't re-render the focus card mid-session or mid-end-flow — that would
  // clobber a running countdown's ack text or a half-typed outcome note.
  if(!focusSession && !focusEndFlow && !focusBreak) renderFocusUI();
  showToast('Synced from another device');
}

const SITE_PASSWORD = '221625';

async function tryUnlock(){
  const input = document.getElementById('lock-input');
  const err = document.getElementById('lock-error');
  if(input.value === SITE_PASSWORD){
    sessionStorage.setItem('fnd-unlocked', 'true');
    document.getElementById('lock-overlay').style.display = 'none';
    document.getElementById('main-wrap').style.removeProperty('display');
    await curriculumReady; // curriculum.json fetch kicked off at script load — usually already done by now
    init();
  } else {
    err.textContent = 'Incorrect password';
    input.value = '';
    input.focus();
  }
}

document.getElementById('lock-input').addEventListener('keydown', e=>{
  if(e.key === 'Enter') tryUnlock();
});

if(sessionStorage.getItem('fnd-unlocked') === 'true'){
  document.getElementById('lock-overlay').style.display = 'none';
  document.getElementById('main-wrap').style.removeProperty('display');
  curriculumReady.then(init);
} else {
  document.getElementById('lock-input').focus();
}

// Registers the offline shell cache — lets the Home Screen app open even
// with no signal. Safe to skip silently on browsers without SW support.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
