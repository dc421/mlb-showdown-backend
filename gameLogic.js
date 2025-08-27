// gameLogic.js - DEFINITIVE FINAL VERSION
function applyOutcome(state, outcome, batter) {
  const newState = JSON.parse(JSON.stringify(state));
  const scoreKey = newState.isTopInning ? 'awayScore' : 'homeScore';
  // Use the displayName passed from the server
  const events = [];
  
  // The runner is the full batter object itself
  const runner = state.batter; 

  // --- Handle the Outcome ---
  // --- Handle the Outcome ---
  // --- NEW: Handle Sacrifice Bunt ---
  if (outcome === 'SAC BUNT') {
    newState.outs++;
    // Runners advance one base if the inning is not over
    if (newState.outs < 3) {
      if (newState.bases.third) { newState[scoreKey]++; newState.bases.third = null; }
      if (newState.bases.second) { newState.bases.third = newState.bases.second; newState.bases.second = null; }
      if (newState.bases.first) { newState.bases.second = newState.bases.first; newState.bases.first = null; }
    }
  }
  else if (outcome === 'SINGLE' || outcome === '1B' || outcome === '1B+') {
      newState.atBatStatus = 'baserunning-decision';
      // Automatically advance runners who are forced
      if (newState.bases.first && newState.bases.second) { newState.bases.third = newState.bases.second; newState.bases.second = newState.bases.first; }
      else if (newState.bases.first) { newState.bases.second = newState.bases.first; }
      newState.bases.first = runner;
      
      // Create decisions for non-forced runners
      newState.baserunningDecisions = {
          runners: [
              { runner: newState.bases.second, from: 2, to: 4 }, // Runner from 2nd can try for home
              { runner: newState.bases.first, from: 1, to: 3 },  // Runner from 1st can try for 3rd
          ].filter(r => r.runner)
      };
  } 
  else if (outcome === '2B') {
      newState.atBatStatus = 'baserunning-decision';
      if (newState.bases.second) { newState.bases.third = newState.bases.second; }
      if (newState.bases.first) { newState.bases.second = newState.bases.first; newState.bases.first = null; }
      
      newState.baserunningDecisions = {
          batter: { from: 0, to: 2 }, // Batter is now the runner
          runners: [
              { runner: newState.bases.third, from: 3, to: 4 } // Runner from 3rd can try for home
          ].filter(r => r.runner)
      };
  } else if (outcome.includes('GB')) {
    if (newState.outs <= 1 && newState.bases.first) {
        const dpRoll = Math.floor(Math.random() * 20) + 1;
        const dpCheck = infieldDefense + dpRoll;
        
        if (dpCheck >= runner.speed) { // Double play successful
            events.push(`${batter.displayName} hits into a double play!`);
            newState.outs += 2;
            newState.bases.first = null; // Runner from first is out
        } else { // Double play fails, fielder's choice
            events.push(`${batter.displayName} grounds into a fielder's choice.`);
            newState.outs++;
            newState.bases.first = runner; // Batter reaches first
        }
    } else { // Not a double play situation
        events.push(`${batter.displayName} gets a ${outcome}!`);
        newState.outs++;
        if (newState.outs < 3 && !state.infieldIn) {
            if (newState.bases.third) { newState[scoreKey]++; newState.bases.third = null; }
            if (newState.bases.second) { newState.bases.third = newState.bases.second; newState.bases.second = null; }
        }
    }
  }
  else if (outcome.includes('FB')) { // Fly Ball
    newState.outs++;
    if (newState.outs < 3 && (newState.bases.first || newState.bases.second || newState.bases.third)) {
        // If it's not the 3rd out and runners are on, pause for a tag-up decision
        newState.atBatStatus = 'tag-up-decision';
        events.push(`${batter.displayName} flies out.`);
        newState.tagUpDecisions = {
            runners: [
                { runner: state.bases.third, from: 3 },
                { runner: state.bases.second, from: 2 },
                { runner: state.bases.first, from: 1 },
            ].filter(r => r.runner)
        };
    } else {
        events.push(`${batter.displayName} gets a ${outcome}!`);
    }
  }
  else if (outcome === 'BB') {
    if (newState.bases.first && newState.bases.second && newState.bases.third) { newState[scoreKey]++; }
    if (newState.bases.first && newState.bases.second) { newState.bases.third = newState.bases.second; }
    if (newState.bases.first) { newState.bases.second = newState.bases.first; }
    newState.bases.first = runner;
  }
  else if (outcome === '3B') {
    if (newState.bases.third) { newState[scoreKey]++; }
    if (newState.bases.second) { newState[scoreKey]++; }
    if (newState.bases.first) { newState[scoreKey]++; }
    newState.bases.third = runner;
    newState.bases.second = null;
    newState.bases.first = null;
  }
  else if (outcome === 'HR') {
    if (newState.bases.third) { newState[scoreKey]++; }
    if (newState.bases.second) { newState[scoreKey]++; }
    if (newState.bases.first) { newState[scoreKey]++; }
    newState[scoreKey]++; // Batter scores
    newState.bases = { first: null, second: null, third: null };
  }
  else { 
    events.push(`${batter.displayName} gets a ${outcome}!`);
    newState.outs++;
  }

  // --- Handle Inning Change ---
  if (newState.outs >= 3) {
    const wasTop = newState.isTopInning;
    newState.isTopInning = !newState.isTopInning;
    if (newState.isTopInning) {
      newState.inning++;
    }
    newState.outs = 0;
    newState.bases = { first: null, second: null, third: null };
    if (newState.inning <= 9 || (newState.inning > 9 && wasTop)) {
      events.push(`--- ${newState.isTopInning ? 'Top' : 'Bottom'} of the ${newState.inning} ---`);
    }
  }
  
  
  const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
  newState[offensiveTeamKey].battingOrderPosition = (newState[offensiveTeamKey].battingOrderPosition + 1) % 9;

  // --- Advance Batter in the Order ---
  if (newState.atBatStatus !== 'baserunning-decision' && newState.atBatStatus !== 'tag-up-decision') {
    const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
    newState[offensiveTeamKey].battingOrderPosition = (newState[offensiveTeamKey].battingOrderPosition + 1) % 9;
  }

  return { newState, events };
}

module.exports = { applyOutcome };