// server.js - DEFINITIVE FINAL VERSION (using fielding_ratings)
if (process.env.NODE_ENV !== 'production') { require('dotenv').config(); }
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const authenticateToken = require('./middleware/authenticateToken');
const { applyOutcome } = require('./gameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ["http://localhost:5173", "https://willowy-griffin-457413.netlify.app"] } });
const PORT = process.env.PORT || 3001;

const dbConfig = {
  user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD, port: process.env.DB_PORT,
};
if (process.env.NODE_ENV === 'production') {
  dbConfig.ssl = { rejectUnauthorized: false };
}
const pool = new Pool(dbConfig);

// --- MIDDLEWARE ---
app.use(express.json());
app.use((req, res, next) => {
  const allowedOrigins = ['https://willowy-griffin-457413.netlify.app', 'http://localhost:5173'];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { return res.sendStatus(200); }
  next();
});

// --- HELPER FUNCTION ---
async function getActivePlayers(gameId, currentState) {
    const participantsResult = await pool.query('SELECT * FROM game_participants WHERE game_id = $1', [gameId]);
    const homeParticipant = participantsResult.rows.find(p => p.user_id === currentState.homeTeam.userId);
    const awayParticipant = participantsResult.rows.find(p => p.user_id !== currentState.homeTeam.userId);
    const offensiveParticipant = currentState.isTopInning ? awayParticipant : homeParticipant;
    const defensiveParticipant = currentState.isTopInning ? homeParticipant : awayParticipant;
    const offensiveTeamState = currentState.isTopInning ? currentState.awayTeam : currentState.homeTeam;
    const batterInfo = offensiveParticipant.lineup.battingOrder[offensiveTeamState.battingOrderPosition];
    const pitcherCardId = defensiveParticipant.lineup.startingPitcher;
    const batterQuery = await pool.query('SELECT * FROM cards_player WHERE card_id = $1', [batterInfo.card_id]);
    const pitcherQuery = await pool.query('SELECT * FROM cards_player WHERE card_id = $1', [pitcherCardId]);
    return {
        batter: batterQuery.rows[0],
        pitcher: pitcherQuery.rows[0],
        offensiveTeam: { userId: offensiveParticipant.user_id, rosterId: offensiveParticipant.roster_id },
        defensiveTeam: { userId: defensiveParticipant.user_id, rosterId: defensiveParticipant.roster_id },
    };
}

// --- API Routes ---

// USER REGISTRATION
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body; // Changed from username
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }
  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      return res.status(409).json({ message: 'Email already exists.' });
    }
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const newUser = await pool.query(
      'INSERT INTO users (email, hashed_password) VALUES ($1, $2) RETURNING user_id, email',
      [email, hashedPassword]
    );
    res.status(201).json({ message: 'User registered successfully!', user: newUser.rows[0] });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'An error occurred on the server.' });
  }
});

// USER LOGIN (Updated)
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }
        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.hashed_password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }
        const payload = { userId: user.user_id, email: user.email }; // Use email in payload
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '3h' });
        res.json({ message: 'Logged in successfully!', token: token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'An error occurred on the server.' });
    }
});

// ROSTERS & CARDS
// CREATE A NEW ROSTER (Protected Route with validation)
// CREATE A NEW ROSTER (with advanced validation)
// In server.js
app.post('/api/rosters', authenticateToken, async (req, res) => {
    const { roster_name, card_ids, starter_ids } = req.body;
    const userId = req.user.userId;

    if (!roster_name || !card_ids || !starter_ids || card_ids.length !== 20) {
        return res.status(400).json({ message: 'Roster must have a name and exactly 20 cards.' });
    }

    const client = await pool.connect();
    try {
        const cardsQuery = await client.query('SELECT card_id, name, points, fielding_ratings, ip, control FROM cards_player WHERE card_id = ANY($1::int[])', [card_ids]);
        const cards = cardsQuery.rows;

        if (cards.length !== 20) {
            return res.status(400).json({ message: 'One or more invalid card IDs were provided.' });
        }
        
        const starters = cards.filter(c => starter_ids.includes(c.card_id));
        const startingPitchers = starters.filter(c => Number(c.ip) > 3);
        const positionPlayers = starters.filter(c => c.control === null);
        const positionCounts = { C: 0, '2B': 0, SS: 0, '3B': 0, CF: 0, LFRF: 0 };
        
        positionPlayers.forEach(card => {
            const positions = card.fielding_ratings ? Object.keys(card.fielding_ratings) : [];
            if (positions.includes('C')) positionCounts.C++;
            if (positions.includes('2B')) positionCounts['2B']++;
            if (positions.includes('SS')) positionCounts.SS++;
            if (positions.includes('3B')) positionCounts['3B']++;
            if (positions.includes('CF')) positionCounts.CF++;
            if (positions.includes('LF') || positions.includes('RF') || positions.includes('LFRF')) positionCounts.LFRF++;
        });

        const errors = [];
        // NEW: Check for duplicate names
        const cardNames = cards.map(c => c.name);
        const uniqueCardNames = new Set(cardNames);
        if (uniqueCardNames.size < cardNames.length) {
            errors.push('You cannot have two players with the same name on your roster.');
        }

        if (starters.length !== 13) errors.push(`You must designate exactly 13 starters (${starters.length} designated).`)
        if (startingPitchers.length !== 4) errors.push(`You must have exactly 4 Starting Pitchers among your starters (${startingPitchers.length} selected).`);
        if (positionPlayers.length !== 9) errors.push(`You must have exactly 9 position players among your starters (${positionPlayers.length} selected).`);
        if (positionCounts.C < 1) errors.push('Your starters need at least 1 Catcher.');
        if (positionCounts['2B'] < 1) errors.push('Your starters need at least 1 Second Baseman.');
        if (positionCounts.SS < 1) errors.push('Your starters need at least 1 Shortstop.');
        if (positionCounts['3B'] < 1) errors.push('Your starters need at least 1 Third Baseman.');
        if (positionCounts.CF < 1) errors.push('Your starters need at least 1 Center Fielder.');
        if (positionCounts.LFRF < 2) errors.push('Your starters need at least 2 LF/RFs.');
        
        if (errors.length > 0) {
            return res.status(400).json({ message: 'Invalid roster composition.', errors: errors });
        }
        
        const totalPoints = cards.reduce((sum, card) => sum + card.points, 0);
        if (totalPoints > 5000) {
            return res.status(400).json({ message: `Roster is over the 5000 point limit. Total: ${totalPoints}` });
        }

        await client.query('BEGIN');
        const newRoster = await client.query('INSERT INTO rosters (user_id, roster_name) VALUES ($1, $2) RETURNING roster_id', [userId, roster_name]);
        const rosterId = newRoster.rows[0].roster_id;
        for (const cardId of card_ids) {
            const isStarter = starter_ids.includes(cardId);
            await client.query('INSERT INTO roster_cards (roster_id, card_id, is_starter) VALUES ($1, $2, $3)', [rosterId, cardId, isStarter]);
        }
        await client.query('COMMIT');
        res.status(201).json({ message: 'Roster created successfully!', rosterId: rosterId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Roster creation error:', error);
        res.status(500).json({ message: 'An error occurred on the server.' });
    } finally {
        client.release();
    }
});

app.get('/api/rosters', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const rosters = await pool.query('SELECT roster_id, roster_name FROM rosters WHERE user_id = $1 ORDER BY roster_name', [userId]);
        res.json(rosters.rows);
    } catch (error) {
        console.error('Error fetching rosters:', error);
        res.status(500).json({ message: 'Server error while fetching rosters.' });
    }
});

// SET A PLAYER'S LINEUP FOR A GAME (Final Version)
app.post('/api/games/:gameId/lineup', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const userId = req.user.userId;
  const { battingOrder, startingPitcher } = req.body;

  if (!battingOrder || battingOrder.length !== 9 || !startingPitcher) {
    return res.status(400).json({ message: 'A valid lineup requires a 9-player batting order and 1 starting pitcher.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query(
      `UPDATE game_participants SET lineup = $1 WHERE game_id = $2 AND user_id = $3`,
      [{ battingOrder, startingPitcher }, gameId, userId]
    );

    // Check if both players have now submitted lineups
    const lineupCheck = await client.query('SELECT lineup FROM game_participants WHERE game_id = $1', [gameId]);
    
    if (lineupCheck.rows.length === 2 && lineupCheck.rows.every(p => p.lineup !== null)) {
      // Both players are ready, START THE GAME!
      const participants = await client.query('SELECT user_id, home_or_away FROM game_participants WHERE game_id = $1', [gameId]);
      const awayPlayer = participants.rows.find(p => p.home_or_away === 'away');
      
      await client.query(
        `UPDATE games SET status = 'in_progress', current_turn_user_id = $1 WHERE game_id = $2`,
        [awayPlayer.user_id, gameId]
      );

      // Emit the signal for both players to go to the game page
      io.to(gameId).emit('game-starting');
    } else {
      // Only one player is ready, just notify them
      io.to(gameId).emit('lineup-submitted');
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Lineup saved successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error setting lineup:', error);
    res.status(500).json({ message: 'Server error while setting lineup.' });
  } finally {
    client.release();
  }
});

// GET A SPECIFIC ROSTER AND ITS CARDS (Protected Route)
app.get('/api/rosters/:rosterId', authenticateToken, async (req, res) => {
  const { rosterId } = req.params;
  try {
    const rosterCards = await pool.query(
      `SELECT cp.*, rc.is_starter FROM cards_player cp 
       JOIN roster_cards rc ON cp.card_id = rc.card_id 
       WHERE rc.roster_id = $1`,
      [rosterId]
    );
    res.json(rosterCards.rows);
  } catch (error) {
    console.error(`Error fetching roster ${rosterId}:`, error);
    res.status(500).json({ message: 'Server error fetching roster details.' });
  }
});

// GET ALL PENDING GAMES (Updated)
app.get('/api/games/open', authenticateToken, async (req, res) => {
  try {
    const openGames = await pool.query(
      `SELECT g.game_id, u.email as host_email FROM games g 
       JOIN game_participants gp ON g.game_id = gp.game_id
       JOIN users u ON gp.user_id = u.user_id
       WHERE g.status = 'pending' AND 
       (SELECT COUNT(*) FROM game_participants WHERE game_id = g.game_id) = 1`
    );
    res.json(openGames.rows);
  } catch (error) {
    console.error('Error fetching open games:', error);
    res.status(500).json({ message: 'Server error while fetching open games.' });
  }
});

// GET ALL GAMES FOR A USER (Protected Route)
app.get('/api/games', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const gamesResult = await pool.query(
      `SELECT g.game_id, g.status, g.current_turn_user_id, gp.roster_id
       FROM games g JOIN game_participants gp ON g.game_id = gp.game_id 
       WHERE gp.user_id = $1 ORDER BY g.created_at DESC`,
      [userId]
    );
    res.json(gamesResult.rows);
  } catch (error) {
    console.error('Error fetching user games:', error);
    res.status(500).json({ message: 'Server error while fetching games.' });
  }
});

app.get('/api/cards/player', authenticateToken, async (req, res) => {
    try {
        const allCards = await pool.query(
          'SELECT card_id, name, team, points, on_base, control, ip, speed, fielding_ratings, chart_data FROM cards_player ORDER BY name'
        );
        res.json(allCards.rows);
    } catch (error) {
        console.error('Error fetching all player cards:', error);
        res.status(500).json({ message: 'Server error while fetching player cards.' });
    }
});

// GAME SETUP & PLAY
app.post('/api/games', authenticateToken, async (req, res) => {
    const { roster_id, home_or_away, league_designation } = req.body;
    const userId = req.user.userId;
    if (!roster_id || !home_or_away || !league_designation) {
        return res.status(400).json({ message: 'roster_id, home_or_away, and league_designation are required.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const newGame = await client.query(`INSERT INTO games (status) VALUES ('pending') RETURNING game_id`);
        const gameId = newGame.rows[0].game_id;
        await client.query(`INSERT INTO game_participants (game_id, user_id, roster_id, home_or_away, league_designation) VALUES ($1, $2, $3, $4, $5)`, [gameId, userId, roster_id, home_or_away, league_designation]);
        await client.query('COMMIT');
        io.emit('games-updated'); // <-- ADD THIS LINE
        res.status(201).json({ message: 'Game created and waiting for an opponent.', gameId: gameId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Game creation error:', error);
        res.status(500).json({ message: 'Server error during game creation.' });
    } finally {
        client.release();
    }
});

// SET UP GAME DETAILS (HOME TEAM, DH RULE)
app.post('/api/games/:gameId/setup', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { homeTeamUserId, useDh } = req.body;

  try {
    await pool.query(
      `UPDATE games SET home_team_user_id = $1, use_dh = $2 WHERE game_id = $3`,
      [homeTeamUserId, useDh, gameId]
    );
    // ADD THIS LINE to notify clients
  io.to(gameId).emit('setup-complete');
    res.status(200).json({ message: 'Game setup complete.' });
  } catch (error) {
    console.error('Error in game setup:', error);
    res.status(500).json({ message: 'Server error during game setup.' });
  }
});

// GET SETUP STATE FOR A SPECIFIC GAME (PARTICIPANTS AND ROLLS)
app.get('/api/games/:gameId/setup', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  try {
    const gameQuery = await pool.query('SELECT setup_rolls FROM games WHERE game_id = $1', [gameId]);
    const participantsQuery = await pool.query(
      `SELECT gp.user_id, u.email FROM game_participants gp
       JOIN users u ON gp.user_id = u.user_id
       WHERE gp.game_id = $1`,
      [gameId]
    );
    res.json({
        rolls: gameQuery.rows[0].setup_rolls || {},
        participants: participantsQuery.rows
    });
  } catch (error) {
    console.error(`Error fetching setup for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error while fetching setup data.' });
  }
});

// ROLL FOR HOME TEAM CHOICE
app.post('/api/games/:gameId/roll', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const userId = req.user.userId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const gameQuery = await client.query('SELECT setup_rolls FROM games WHERE game_id = $1', [gameId]);
    let rolls = gameQuery.rows[0].setup_rolls || {};

    // Generate and store the roll if the user hasn't rolled yet
    if (!rolls[userId]) {
        rolls[userId] = Math.floor(Math.random() * 20) + 1;
    }

    await client.query('UPDATE games SET setup_rolls = $1 WHERE game_id = $2', [rolls, gameId]);
    await client.query('COMMIT');

    // Notify the room that the setup state has changed
    io.to(gameId).emit('roll-updated');
    res.sendStatus(200);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during roll:', error);
    res.status(500).json({ message: 'Server error during roll.' });
  } finally {
    client.release();
  }
});

app.post('/api/games/:gameId/join', authenticateToken, async (req, res) => {
    const { gameId } = req.params;
    const { roster_id } = req.body;
    const joiningUserId = req.user.userId;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const gameResult = await client.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
        if (gameResult.rows.length === 0) return res.status(404).json({ message: 'Game not found.' });
        if (gameResult.rows[0].status !== 'pending') return res.status(400).json({ message: 'This game is not available to join.' });
        const participantsResult = await client.query('SELECT * FROM game_participants WHERE game_id = $1', [gameId]);
        if (participantsResult.rows.length >= 2) return res.status(400).json({ message: 'This game is already full.' });
        if (participantsResult.rows[0].user_id === joiningUserId) return res.status(400).json({ message: 'You cannot join your own game.' });
        const hostPlayerParticipant = participantsResult.rows[0];
        let homePlayer, awayPlayer;
        const joiningPlayerHomeOrAway = hostPlayerParticipant.home_or_away === 'home' ? 'away' : 'home';
        const joiningPlayerLeague = hostPlayerParticipant.league_designation === 'AL' ? 'NL' : 'AL';
        const joiningPlayerParticipant = { user_id: joiningUserId, roster_id: roster_id, home_or_away: joiningPlayerHomeOrAway, league_designation: joiningPlayerLeague };
        if (hostPlayerParticipant.home_or_away === 'home') {
            homePlayer = hostPlayerParticipant;
            awayPlayer = joiningPlayerParticipant;
        } else {
            homePlayer = joiningPlayerParticipant;
            awayPlayer = hostPlayerParticipant;
        }
        await client.query(`INSERT INTO game_participants (game_id, user_id, roster_id, home_or_away, league_designation) VALUES ($1, $2, $3, $4, $5)`, [gameId, joiningUserId, roster_id, joiningPlayerHomeOrAway, joiningPlayerLeague]);
        const initialGameState = { inning: 1, isTopInning: true, awayScore: 0, homeScore: 0, outs: 0, bases: { first: null, second: null, third: null }, awayTeam: { rosterId: awayPlayer.roster_id, userId: awayPlayer.user_id, battingOrderPosition: 0 }, homeTeam: { rosterId: homePlayer.roster_id, userId: homePlayer.user_id, battingOrderPosition: 0 }};
        await client.query(`INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)`, [gameId, 1, initialGameState]);
        await client.query('COMMIT');
        io.emit('games-updated');
        res.json({ message: 'Successfully joined game. The game is now in progress!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Game join error:', error);
        res.status(500).json({ message: 'Server error while joining game.' });
    } finally {
        client.release();
    }
});

// GET A SPECIFIC GAME'S STATE AND EVENTS (Definitive Version)
app.get('/api/games/:gameId', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  try {
    const gameResult = await pool.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
    if (gameResult.rows.length === 0) return res.status(404).json({ message: 'Game not found.' });
    const game = gameResult.rows[0];

    const stateResult = await pool.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    if (stateResult.rows.length === 0) return res.status(404).json({ message: 'Game state not found.' });
    const currentState = stateResult.rows[0];

    const eventsResult = await pool.query('SELECT * FROM game_events WHERE game_id = $1 ORDER BY "timestamp" ASC', [gameId]);
    const participantsResult = await pool.query('SELECT * FROM game_participants WHERE game_id = $1', [gameId]);
    
    // --- CORRECTED LOGIC TO FIND BATTER AND PITCHER ---
    let batter = null;
    let pitcher = null;
    if (game.status === 'in_progress') {
        const activePlayers = await getActivePlayers(gameId, currentState.state_data);
        batter = activePlayers.batter;
        pitcher = activePlayers.pitcher;
    }

    // This part is new for fetching full lineup details
    const lineups = { home: [], away: [] };
    for (const p of participantsResult.rows) {
        if (p.lineup?.battingOrder) {
            const cardIds = p.lineup.battingOrder.map(spot => spot.card_id);
            const cardsResult = await pool.query('SELECT card_id, name FROM cards_player WHERE card_id = ANY($1::int[])', [cardIds]);
            const lineupWithNames = p.lineup.battingOrder.map(spot => ({
                ...spot,
                player: cardsResult.rows.find(c => c.card_id === spot.card_id)
            }));
            if (p.user_id === game.home_team_user_id) lineups.home = lineupWithNames;
            else lineups.away = lineupWithNames;
        }
    }

    res.json({
      game,
      gameState: currentState,
      gameEvents: eventsResult.rows,
      batter,
      pitcher,
      lineups
    });
  } catch (error) {
    console.error(`Error fetching game data for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error while fetching game data.' });
  }
});

// STEP 1 OF AT-BAT: PITCH
app.post('/api/games/:gameId/pitch', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    let currentState = stateResult.rows[0].state_data;
    const currentTurn = stateResult.rows[0].turn_number;

    const { batter, pitcher, offensiveTeam, defensiveTeam } = await getActivePlayers(gameId, currentState);

    // Roll for advantage
    const pitchRoll = Math.floor(Math.random() * 20) + 1;
    const advantageCheck = pitchRoll + pitcher.control;
    const advantage = advantageCheck >= batter.on_base ? 'pitcher' : 'batter';
    
    // Create a new state with the pitch result
    const newState = { ...currentState };
    newState.atBatStatus = 'swinging'; // Update status
    newState.pitchRollResult = {
        roll: pitchRoll,
        total: advantageCheck,
        advantage: advantage
    };
    
    await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
    await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [offensiveTeam.userId, gameId]);
    await client.query('COMMIT');
    
    io.to(gameId).emit('game-updated');
    res.status(200).json({ message: 'Pitch thrown.' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: 'Server error during pitch.' });
  } finally {
    client.release();
  }
});

// In server.js
app.post('/api/games/:gameId/swing', authenticateToken, async (req, res) => {
  // ... (code to get state, batter, pitcher is the same)
  const { newState, events } = applyOutcome(currentState.state_data, outcome, batter.name);

  // ... (code to update game state is the same)

  // Save all new events to the database
  for (const logMessage of events) {
    await client.query(
      `INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)`,
      [gameId, userId, currentTurn + 1, 'game_event', logMessage]
    );
  }
  // ... (rest of the function)
});

// GET A USER'S PARTICIPANT INFO FOR A SPECIFIC GAME
app.get('/api/games/:gameId/my-roster', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const userId = req.user.userId;
  try {
    const result = await pool.query(
      `SELECT roster_id FROM game_participants WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Participant not found in this game.' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching participant data.' });
  }
});

// TEST ROUTE
app.get('/api/test', async (req, res) => {
    try {
        const dbTime = await pool.query('SELECT NOW()');
        res.json({ message: 'API server is running and connected to the database!', dbTime: dbTime.rows[0].now });
    } catch (error) {
        console.error('Database connection test failed:', error);
        res.status(500).json({ message: 'Error connecting to the database.' });
    }
});


// --- SOCKET.IO ---
io.on('connection', (socket) => {
  console.log('A user connected');
  socket.on('join-game-room', (gameId) => {
    socket.join(gameId);
  });
  socket.on('choice-made', (data) => {
    socket.to(data.gameId).emit('choice-updated', { homeTeamUserId: data.homeTeamUserId });
  });
  socket.on('dh-rule-changed', (data) => {
    socket.to(data.gameId).emit('dh-rule-updated', { useDh: data.useDh });
  });
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// --- SERVER STARTUP ---
async function startServer() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connection successful!');
    server.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ DATABASE CONNECTION FAILED:', error);
    process.exit(1);
  }
}
startServer();