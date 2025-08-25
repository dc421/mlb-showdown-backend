// gameLogic.js

function applyOutcome(state, outcome) {
  const newState = JSON.parse(JSON.stringify(state)); // Deep copy to modify
  const scoreKey = newState.isTopInning ? 'awayScore' : 'homeScore';
  let runnersAdvanced = 0;
  const events = [`${batterName} gets a ${outcome}!`]; // Start with the at-bat outcome

  // --- Handle the Outcome ---
  
  // -- OUTS --
  if (outcome.startsWith('OUT') || outcome === 'SO' || outcome === 'PU') {
    newState.outs++;
  }
  
  // -- WALK --
  else if (outcome === 'BB') {
    // Batter to first. Advance runners only if forced.
    if (newState.bases.first && newState.bases.second && newState.bases.third) { // Bases loaded
      runnersAdvanced++;
      newState.bases.third = 'runner';
    }
    if (newState.bases.first && newState.bases.second) { // Runners on 1st and 2nd
      newState.bases.third = 'runner';
    }
    if (newState.bases.first) { // Runner on 1st
      newState.bases.second = 'runner';
    }
    newState.bases.first = 'batter';
  }
  
  // -- SINGLE --
  else if (outcome.includes('1B')) {
    // Simple baserunning: runners advance one base
    if (newState.bases.third) { runnersAdvanced++; }
    if (newState.bases.second) { newState.bases.third = 'runner'; }
    if (newState.bases.first) { newState.bases.second = 'runner'; }
    newState.bases.first = 'batter';
  }

  // -- DOUBLE --
  else if (outcome === '2B') {
    // Simple baserunning: runners advance two bases
    if (newState.bases.third) { runnersAdvanced++; }
    if (newState.bases.second) { runnersAdvanced++; }
    if (newState.bases.first) { newState.bases.third = 'runner'; }
    newState.bases.second = 'batter';
    newState.bases.first = null;
  }
  
  // -- TRIPLE --
  else if (outcome === '3B') {
    // Simple baserunning: all runners score
    if (newState.bases.third) { runnersAdvanced++; }
    if (newState.bases.second) { runnersAdvanced++; }
    if (newState.bases.first) { runnersAdvanced++; }
    newState.bases.third = 'batter';
    newState.bases.second = null;
    newState.bases.first = null;
  }
  
  // -- HOME RUN --
  else if (outcome === 'HR') {
    // All runners score, including the batter
    if (newState.bases.third) { runnersAdvanced++; }
    if (newState.bases.second) { runnersAdvanced++; }
    if (newState.bases.first) { runnersAdvanced++; }
    runnersAdvanced++; // The batter scores
    // Clear all bases
    newState.bases = { first: null, second: null, third: null };
  }

  // Update the score based on runners advanced
  newState[scoreKey] += runnersAdvanced;

  // --- Handle Inning Change ---
  if (newState.outs >= 3) {
    newState.isTopInning = !newState.isTopInning;
    if (newState.isTopInning) newState.inning++;
    newState.outs = 0;
    newState.bases = { first: null, second: null, third: null };
    // Add the new inning event
    events.push(`--- ${newState.isTopInning ? 'Top' : 'Bottom'} of the ${newState.inning} ---`);
  }
  
  const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
  newState[offensiveTeamKey].battingOrderPosition++;
  if (newState[offensiveTeamKey].battingOrderPosition >= 9) {
    newState[offensiveTeamKey].battingOrderPosition = 0;
  }

  return { newState, events };
}

// Make the function available to other files
module.exports = { applyOutcome };