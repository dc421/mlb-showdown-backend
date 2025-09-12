function applyOutcome(state, outcome, batter, pitcher, infieldDefense = 0) {
  const newState = JSON.parse(JSON.stringify(state));
  const scoreKey = newState.isTopInning ? 'awayScore' : 'homeScore';
  const events = [];
  
  const runnerData = { 
    ...batter,
    pitcherOfRecordId: pitcher.card_id 
  };

  const scoreRun = (runnerOnBase) => {
    if (!runnerOnBase) return;
    newState[scoreKey]++;
    events.push(`${runnerOnBase.name} scores!`);
    const pitcherId = runnerOnBase.pitcherOfRecordId;
    if (newState.pitcherStats[pitcherId]) {
      newState.pitcherStats[pitcherId].runs++;
    } else {
      newState.pitcherStats[pitcherId] = { ip: 0, runs: 1 };
    }
  };
  
  // --- HANDLE OUTCOMES ---
  if (outcome === 'SAC BUNT') {
    events.push(`${batter.displayName} lays down a sacrifice bunt.`);
    newState.outs++;
    if (newState.outs < 3) {
      if (newState.bases.third) { scoreRun(newState.bases.third); }
      if (newState.bases.second) { newState.bases.third = newState.bases.second; }
      if (newState.bases.first) { newState.bases.second = newState.bases.first; }
      newState.bases.first = null;
    }
  }
  else if (outcome.includes('GB')) {
    if (state.infieldIn && newState.outs < 2 && newState.bases.third) {
        newState.atBatStatus = 'infield-in-decision';
        events.push(`${batter.displayName} hits a ground ball with the infield in...`);
        newState.currentPlay = { type: 'INFIELD_IN', runner: newState.bases.third, batter: runnerData };
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
        events.push(`${batter.displayName} grounds out.`);
        newState.outs++;
        if (newState.outs < 3 && !state.infieldIn) {
            if (newState.bases.third) { scoreRun(newState.bases.third); }
            if (newState.bases.second) { newState.bases.third = newState.bases.second; }
            newState.bases.second = null;
        }
    }
  }
  else if (outcome.includes('FB')) {
    newState.outs++;
    if (newState.outs < 3 && (newState.bases.first || newState.bases.second || newState.bases.third)) {
        newState.atBatStatus = 'offensive-baserunning-decision';
        events.push(`${batter.displayName} flies out.`);
        newState.currentPlay = { hitType: 'FB', decisions: [
            { runner: state.bases.third, from: 3 },
            { runner: state.bases.second, from: 2 },
            { runner: state.bases.first, from: 1 },
        ].filter(d => d.runner) };
    } else {
        events.push(`${batter.displayName} flies out.`);
    }
  }
  else if (outcome === 'SINGLE' || outcome === '1B' || outcome === '1B+') {
      events.push(`${batter.displayName} hits a SINGLE!`);
      const decisions = [
        { runner: state.bases.second, from: 2 },
        { runner: state.bases.first, from: 1 },
      ].filter(d => d.runner);
      if (newState.bases.third) { scoreRun(newState.bases.third); newState.bases.third = null; }
      if (newState.bases.second) { newState.bases.third = newState.bases.second; newState.bases.second = null; }
      if (newState.bases.first) { newState.bases.second = newState.bases.first; }
      newState.bases.first = runnerData;
      if (outcome === '1B+' && !newState.bases.second) {
          newState.bases.second = newState.bases.first;
          newState.bases.first = null;
          events.push(`${batter.displayName} steals second base!`);
      } else if (decisions.length > 0) {
          newState.atBatStatus = 'offensive-baserunning-decision';
          newState.currentPlay = { hitType: '1B', decisions: decisions };
      }
  }
  else if (outcome === '2B') {
      events.push(`${batter.displayName} hits a DOUBLE!`);
      const runnerFromThird = state.bases.third;
      if (newState.bases.second) { scoreRun(newState.bases.second); newState.bases.second = null; }
      if (newState.bases.first) { newState.bases.third = newState.bases.first; newState.bases.first = null; }
      newState.bases.second = runnerData;
      if (runnerFromThird) {
        newState.atBatStatus = 'offensive-baserunning-decision';
        newState.currentPlay = { hitType: '2B', decisions: [{ runner: runnerFromThird, from: 3 }] };
      }
  }
  else if (outcome === 'BB') {
    events.push(`${batter.displayName} walks.`);
    if (newState.bases.first && newState.bases.second && newState.bases.third) { scoreRun(newState.bases.third); }
    if (newState.bases.first && newState.bases.second) { newState.bases.third = newState.bases.second; }
    if (newState.bases.first) { newState.bases.second = newState.bases.first; }
    newState.bases.first = runnerData;
  }
  else if (outcome === '3B') {
    events.push(`${batter.displayName} hits a TRIPLE!`);
    if (newState.bases.third) { scoreRun(newState.bases.third); }
    if (newState.bases.second) { scoreRun(newState.bases.second); }
    if (newState.bases.first) { scoreRun(newState.bases.first); }
    newState.bases.third = runnerData;
    newState.bases.second = null;
    newState.bases.first = null;
  }
  else if (outcome === 'HR') {
    events.push(`${batter.displayName} hits a HOME RUN!`);
    if (newState.bases.third) { scoreRun(newState.bases.third); }
    if (newState.bases.second) { scoreRun(newState.bases.second); }
    if (newState.bases.first) { scoreRun(newState.bases.first); }
    scoreRun(runnerData);
    newState.bases = { first: null, second: null, third: null };
  }
  else if (outcome === 'SO') {
    events.push(`${batter.displayName} strikes out.`);
  }
  else if (outcome === 'HR') {
    events.push(`${batter.displayName} pops out.`);
  }
  else { 
    events.push(`${batter.displayName} is out.`);
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
    if (newState.isTopInning) newState.inning++;
    newState.outs = 0;
    newState.bases = { first: null, second: null, third: null };
    // The inning change event itself is now created in server.js
  }
  
  return { newState, events };
}

module.exports = { applyOutcome };