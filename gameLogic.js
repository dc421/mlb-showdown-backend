// gameLogic.js - DEFINITIVE FINAL VERSION

function applyOutcome(state, outcome, batter, pitcher, infieldDefense = 0) {
  const newState = JSON.parse(JSON.stringify(state));
  const scoreKey = newState.isTopInning ? 'awayScore' : 'homeScore';
  const events = [];
  
  const runnerData = { runner: batter, pitcherOfRecordId: pitcher.card_id };

  const scoreRun = (runnerOnBase) => {
    if (!runnerOnBase) return;
    newState[scoreKey]++;
    const pitcherId = runnerOnBase.pitcherOfRecordId;
    if (newState.pitcherStats[pitcherId]) {
      newState.pitcherStats[pitcherId].runs++;
    } else {
      // This case handles if a pitcher's stats haven't been initialized yet
      newState.pitcherStats[pitcherId] = { ip: 0, runs: 1 };
    }
  };
  
  // The initial event is added only if it's not a decision state
  if (!outcome.includes('GB') && !outcome.includes('FB') && !outcome.includes('1B') && !outcome.includes('2B')) {
      events.push(`${batter.displayName} gets a ${outcome}!`);
  }

  // --- HANDLE OUTCOMES ---
  if (outcome === 'SAC BUNT') {
    events.push(`${batter.displayName} lays down a sacrifice bunt!`);
    newState.outs++;
    if (newState.outs < 3) {
      if (newState.bases.third) { scoreRun(newState.bases.third); newState.bases.third = newState.bases.second; }
      else if (newState.bases.second) { newState.bases.third = newState.bases.second; }
      if (newState.bases.first) { newState.bases.second = newState.bases.first; }
      newState.bases.first = null;
    }
  }
  else if (outcome.includes('GB')) {
    if (state.infieldIn && newState.outs < 2 && newState.bases.third) {
        newState.atBatStatus = 'infield-in-decision';
        events.push(`${batter.displayName} hits a ground ball with the infield in...`);
        newState.infieldInDecision = { runner: newState.bases.third, batter: batter };
    }
    else if (newState.outs <= 1 && newState.bases.first) {
        const dpRoll = Math.floor(Math.random() * 20) + 1;
        if ((infieldDefense + dpRoll) >= batter.speed) {
            events.push(`${batter.displayName} hits into a double play!`);
            newState.outs += 2;
            newState.bases.first = null;
        } else {
            events.push(`${batter.displayName} grounds into a fielder's choice. Out at second.`);
            newState.outs++;
            newState.bases.first = runnerData;
        }
    } else {
        events.push(`${batter.displayName} gets a ${outcome}!`);
        newState.outs++;
        if (newState.outs < 3 && !state.infieldIn) {
            if (newState.bases.third) { scoreRun(newState.bases.third); newState.bases.third = newState.bases.second; }
            else if (newState.bases.second) { newState.bases.third = newState.bases.second; }
            newState.bases.second = null;
        }
    }
  }
 else if (outcome.includes('FB')) {
    newState.outs++;
    if (newState.outs < 3 && (newState.bases.first || newState.bases.second || newState.bases.third)) {
        newState.atBatStatus = 'offensive-baserunning-decision';
        events.push(`${batter.displayName} flies out.`);
        newState.currentPlay = {
          batter: null, // Batter is out
          hitType: 'FB',
          decisions: [ // Tag-up decisions
            { runner: state.bases.third, from: 3, to: 4, isAuto: false },
            { runner: state.bases.second, from: 2, to: 3, isAuto: false },
            { runner: state.bases.first, from: 1, to: 2, isAuto: false },
          ].filter(d => d.runner)
        };
    } else {
        events.push(`${batter.displayName} flies out.`);
    }
  }
  else if (outcome === 'SINGLE' || outcome === '1B' || outcome === '1B+') {
      events.push(`${batter.displayName} hits a SINGLE!`);
      

  // First, figure out what the potential decisions are
  const decisions = [
    { runner: state.bases.second, from: 2 }, // Runner from 2nd can try for home
    { runner: state.bases.first, from: 1 },  // Runner from 1st can try for 3rd
  ].filter(d => d.runner);

      // Automatically advance any forced runners
  if (newState.bases.third) { scoreRun(newState.bases.third); newState.bases.third = null; }
  if (newState.bases.second) { newState.bases.third = newState.bases.second; newState.bases.second = null; }
  if (newState.bases.first) { newState.bases.second = newState.bases.first; }
  newState.bases.first = runnerData;
      
  // Handle 1B+ automatic advance
  if (outcome === '1B+' && !newState.bases.second) {
      newState.bases.second = newState.bases.first;
      newState.bases.first = null;
      events.push(`${batter.displayName} steals second base!`);
  }
      // NOW, check if there are any decisions left to be made
  else if (decisions.length > 0) {
    newState.atBatStatus = 'offensive-baserunning-decision';
    newState.currentPlay = {
      hitType: '1B',
      decisions: decisions
    };
  }
  }
  else if (outcome === '2B') {
      events.push(`${batter.displayName} hits a DOUBLE!`);
  const runnerFromThird = state.bases.third; // Check for a runner on 3rd BEFORE moving anyone
  
  // Handle automatic baserunner advancement
  if (newState.bases.second) { scoreRun(newState.bases.second); newState.bases.second = null; }
  if (newState.bases.first) { newState.bases.third = newState.bases.first; newState.bases.first = null; }
  newState.bases.second = runnerData;

  // Now, ONLY enter a decision state if there was a runner on third
  if (runnerFromThird) {
    newState.atBatStatus = 'offensive-baserunning-decision';
    newState.currentPlay = {
      hitType: '2B',
      decisions: [{ runner: runnerFromThird, from: 3 }]
    };
  }
  }
  else if (outcome === 'BB') {
    if (newState.bases.first && newState.bases.second && newState.bases.third) { scoreRun(newState.bases.first); }
    if (newState.bases.first && newState.bases.second) { newState.bases.third = newState.bases.second; }
    if (newState.bases.first) { newState.bases.second = newState.bases.first; }
    newState.bases.first = runnerData;
  }
  else if (outcome === '3B') {
    if (newState.bases.third) { scoreRun(newState.bases.third); }
    if (newState.bases.second) { scoreRun(newState.bases.second); }
    if (newState.bases.first) { scoreRun(newState.bases.first); }
    newState.bases.third = runnerData;
    newState.bases.second = null;
    newState.bases.first = null;
  }
  else if (outcome === 'HR') {
    if (newState.bases.third) { scoreRun(newState.bases.third); }
    if (newState.bases.second) { scoreRun(newState.bases.second); }
    if (newState.bases.first) { scoreRun(newState.bases.first); }
    scoreRun({ pitcherOfRecordId: pitcher.card_id }); // Batter scores
    newState.bases = { first: null, second: null, third: null };
  }
  else { 
    newState.outs++;
  }

  // --- Walk-off Win Check ---
  if (!newState.isTopInning && newState.inning >= 9 && newState.homeScore > newState.awayScore) {
    newState.gameOver = true;
    newState.winningTeam = 'home';
    events.push(`--- HOME TEAM WINS! WALK-OFF! ---`);
  }

  // --- Handle Inning Change ---
  if (newState.outs >= 3 && !newState.gameOver) {
    const wasTop = newState.isTopInning;
    newState.isTopInning = !newState.isTopInning;
    if (newState.isTopInning) {
      newState.inning++;
    }
    newState.outs = 0;
    newState.bases = { first: null, second: null, third: null };
    events.push(`--- ${newState.isTopInning ? 'Top' : 'Bottom'} of the ${newState.inning} ---`);
  }
  
  return { newState, events };
}

module.exports = { applyOutcome };