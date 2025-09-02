// server.js - DEFINITIVE FINAL VERSION
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
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
const io = module.exports.io = new Server(server, { cors: { origin: ["http://localhost:5173", "https://willowy-griffin-457413.netlify.app"] } });
const PORT = process.env.PORT || 3001;

const dbConfig = {
  user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD, port: process.env.DB_PORT,
};
if (process.env.NODE_ENV === 'production') {
  dbConfig.ssl = { rejectUnauthorized: false };
}
const pool = module.exports.pool = new Pool(dbConfig);
app.use(express.json());

// --- MIDDLEWARE ---
app.use((req, res, next) => {
  const allowedOrigins = ['https://willowy-griffin-457413.netlify.app', 'http://localhost:5173'];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { return res.sendStatus(200); }
  next();
});

// in server.js
// in server.js
async function getActivePlayers(gameId, currentState) {
    try {
        const participantsResult = await pool.query('SELECT * FROM game_participants WHERE game_id = $1', [gameId]);
        const game = await pool.query('SELECT home_team_user_id FROM games WHERE game_id = $1', [gameId]);

        const homeParticipant = participantsResult.rows.find(p => p.user_id === game.rows[0].home_team_user_id);
        const awayParticipant = participantsResult.rows.find(p => p.user_id !== game.rows[0].home_team_user_id);

        const offensiveParticipant = currentState.isTopInning ? awayParticipant : homeParticipant;
        const defensiveParticipant = currentState.isTopInning ? homeParticipant : awayParticipant;
        
        if (!offensiveParticipant?.lineup || !defensiveParticipant?.lineup) {
          return { batter: null, pitcher: null, offensiveTeam: {}, defensiveTeam: {} };
        }
        
        const offensiveTeamState = currentState.isTopInning ? currentState.awayTeam : currentState.homeTeam;
        
        const batterInfo = offensiveParticipant.lineup.battingOrder[offensiveTeamState.battingOrderPosition];
        const pitcherCardId = defensiveParticipant.lineup.startingPitcher;

        const batterQuery = await pool.query('SELECT * FROM cards_player WHERE card_id = $1', [batterInfo.card_id]);
        const pitcherQuery = await pool.query('SELECT * FROM cards_player WHERE card_id = $1', [pitcherCardId]);
        
        return {
            batter: batterQuery.rows[0],
            pitcher: pitcherQuery.rows[0],
            offensiveTeam: offensiveParticipant,
            defensiveTeam: defensiveParticipant,
        };
    } catch (error) {
        // THIS LOG WILL SHOW US THE HIDDEN ERROR
        console.error('--- CRITICAL ERROR inside getActivePlayers ---', error);
        throw error; // Re-throw the error to be caught by the main endpoint
    }
}

async function getOutfieldDefense(defensiveParticipant) {
    if (!defensiveParticipant?.lineup?.battingOrder) return 0;
    const lineup = defensiveParticipant.lineup.battingOrder;
    const outfielderCardIds = lineup.filter(spot => ['LF', 'CF', 'RF'].includes(spot.position)).map(spot => spot.card_id);
    if (outfielderCardIds.length === 0) return 0;
    const cardsResult = await pool.query('SELECT fielding_ratings FROM cards_player WHERE card_id = ANY($1::int[])', [outfielderCardIds]);
    let totalDefense = 0;
    cardsResult.rows.forEach(card => {
        const ratings = card.fielding_ratings;
        if (ratings.LF) totalDefense += ratings.LF;
        if (ratings.CF) totalDefense += ratings.CF;
        if (ratings.RF) totalDefense += ratings.RF;
    });
    return totalDefense;
}

async function getInfieldDefense(defensiveParticipant) {
    if (!defensiveParticipant?.lineup?.battingOrder) return 0;
    const lineup = defensiveParticipant.lineup.battingOrder;
    const infielderCardIds = lineup.filter(spot => ['C', '1B', '2B', 'SS', '3B'].includes(spot.position)).map(spot => spot.card_id);
    if (infielderCardIds.length === 0) return 0;
    const cardsResult = await pool.query('SELECT fielding_ratings FROM cards_player WHERE card_id = ANY($1::int[])', [infielderCardIds]);
    let totalDefense = 0;
    cardsResult.rows.forEach(card => {
        const ratings = card.fielding_ratings;
        const ratingValues = Object.values(ratings);
        if (ratingValues.length > 0) {
            totalDefense += ratingValues[0];
        }
    });
    return totalDefense;
}

// --- HELPER FUNCTIONS ---
// --- HELPER FUNCTIONS ---
function processPlayers(playersToProcess, allPlayers) {
    const nameCounts = {};
    allPlayers.forEach(p => { nameCounts[p.name] = (nameCounts[p.name] || 0) + 1; });
    playersToProcess.forEach(p => {
        if (!p) return;
        p.displayName = nameCounts[p.name] > 1 ? `${p.name} (${p.team})` : p.name;
        if (p.control !== null) {
            p.displayPosition = Number(p.ip) > 3 ? 'SP' : 'RP';
        } else {
            const positions = p.fielding_ratings ? Object.keys(p.fielding_ratings).join(',') : 'DH';
            p.displayPosition = positions.replace(/LFRF/g, 'LF/RF');
        }
    });
    return playersToProcess;
};


// --- API Routes ---

app.use('/api/dev', require('./routes/dev'));

// USER REGISTRATION (Updated for Teams)
app.post('/api/register', async (req, res) => {
  const { email, password, owner_first_name, owner_last_name, team_id } = req.body;
  if (!email || !password || !owner_first_name || !owner_last_name || !team_id) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if team is already claimed
    const teamCheck = await client.query('SELECT user_id FROM teams WHERE team_id = $1', [team_id]);
    if (teamCheck.rows[0].user_id !== null) {
      return res.status(409).json({ message: 'This team has already been claimed.' });
    }

    // Create the new user
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const newUserResult = await client.query(
      'INSERT INTO users (email, hashed_password, owner_first_name, owner_last_name, team_id) VALUES ($1, $2, $3, $4, $5) RETURNING user_id',
      [email, hashedPassword, owner_first_name, owner_last_name, team_id]
    );
    const userId = newUserResult.rows[0].user_id;

    // Claim the team by assigning the new user's ID to it
    await client.query('UPDATE teams SET user_id = $1 WHERE team_id = $2', [userId, team_id]);
    
    await client.query('COMMIT');
    res.status(201).json({ message: 'User registered and team claimed successfully!' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Registration error:', error);
    res.status(500).json({ message: 'An error occurred on the server.' });
  } finally {
    client.release();
  }
});

// USER LOGIN (Updated to include team data)
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
        
        // Fetch the user's team info
        const teamResult = await pool.query('SELECT * FROM teams WHERE team_id = $1', [user.team_id]);
        
        // Create a token that includes all necessary user and team data
        const payload = { 
            userId: user.user_id, 
            email: user.email,
            owner: `${user.owner_first_name} ${user.owner_last_name}`,
            team: teamResult.rows[0] // Embed the full team object
        };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });
        
        res.json({ message: 'Logged in successfully!', token: token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'An error occurred on the server.' });
    }
});

// --- SINGLE ROSTER ENDPOINTS ---
// in server.js
app.get('/api/my-roster', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const rosterResult = await pool.query('SELECT roster_id, user_id FROM rosters WHERE user_id = $1', [userId]);
        if (rosterResult.rows.length === 0) {
            return res.json(null);
        }
        
        const roster = rosterResult.rows[0];
        const cardsResult = await pool.query(
            `SELECT cp.*, rc.is_starter, rc.assignment 
             FROM cards_player cp 
             JOIN roster_cards rc ON cp.card_id = rc.card_id 
             WHERE rc.roster_id = $1`,
            [roster.roster_id]
        );
        
        res.json({ ...roster, cards: cardsResult.rows });

    } catch (error) {
        console.error('Error fetching user roster:', error);
        res.status(500).json({ message: 'Server error while fetching roster.' });
    }
});

// CREATE or UPDATE a user's single roster (Upsert)
app.post('/api/my-roster', authenticateToken, async (req, res) => {
    const { cards } = req.body;
    const userId = req.user.userId;

    if (!cards || cards.length !== 20) {
        return res.status(400).json({ message: 'A valid roster requires a name and 20 cards.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const existingRoster = await client.query('SELECT roster_id FROM rosters WHERE user_id = $1', [userId]);
        let rosterId;

        if (existingRoster.rows.length > 0) {
            rosterId = existingRoster.rows[0].roster_id;
            await client.query('DELETE FROM roster_cards WHERE roster_id = $1', [rosterId]);
        } else {
            const newRoster = await client.query('INSERT INTO rosters (user_id) VALUES ($1) RETURNING roster_id', [userId]);
            rosterId = newRoster.rows[0].roster_id;
        }

        // Insert the new set of cards with their specific assignments
        for (const card of cards) {
            await client.query(
                'INSERT INTO roster_cards (roster_id, card_id, is_starter, assignment) VALUES ($1, $2, $3, $4)',
                [rosterId, card.card_id, card.is_starter, card.assignment]
            );
        }
        
        await client.query('COMMIT');
        res.status(201).json({ message: 'Roster saved successfully!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Roster save error:', error);
        res.status(500).json({ message: 'An error occurred on the server.' });
    } finally {
        client.release();
    }
});

// POST /api/games/:gameId/lineup (This is where the bug was)
// in server.js
app.post('/api/games/:gameId/lineup', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const userId = req.user.userId;
  const { battingOrder, startingPitcher } = req.body;

  if (!battingOrder || battingOrder.length !== 9 || !startingPitcher) {
    return res.status(400).json({ message: 'A valid lineup is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query(
      `UPDATE game_participants SET lineup = $1::jsonb WHERE game_id = $2 AND user_id = $3`,
      [JSON.stringify({ battingOrder, startingPitcher }), gameId, userId]
    );

    const allParticipants = await client.query('SELECT user_id, roster_id, lineup FROM game_participants WHERE game_id = $1', [gameId]);
    
    if (allParticipants.rows.length === 2 && allParticipants.rows.every(p => p.lineup !== null)) {
      const game = await client.query('SELECT home_team_user_id FROM games WHERE game_id = $1', [gameId]);
      const homePlayerId = game.rows[0].home_team_user_id;

      const homeParticipant = allParticipants.rows.find(p => Number(p.user_id) === Number(homePlayerId));
      const awayParticipant = allParticipants.rows.find(p => Number(p.user_id) !== Number(homePlayerId));
      
      await client.query(
        `UPDATE games SET status = 'in_progress', current_turn_user_id = $1 WHERE game_id = $2`,
        [homePlayerId, gameId]
      );

      const initialGameState = {
        inning: 1, isTopInning: true, awayScore: 0, homeScore: 0, outs: 0,
        bases: { first: null, second: null, third: null },
        atBatStatus: 'pitching', pitcherStats: {},
        awayTeam: { userId: awayParticipant.user_id, rosterId: awayParticipant.roster_id, lineup: awayParticipant.lineup, battingOrderPosition: 0 },
        homeTeam: { userId: homeParticipant.user_id, rosterId: homeParticipant.roster_id, lineup: homeParticipant.lineup, battingOrderPosition: 0 },
      };

      await client.query(`INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)`, [gameId, 1, initialGameState]);
      
      console.log(`--- BACKEND: Emitting 'game-starting' to room ${gameId} ---`);
      io.to(gameId).emit('game-starting');
    } else {
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

// server.js

// GET ALL AVAILABLE TEAMS FOR REGISTRATION
app.get('/api/available-teams', async (req, res) => {
  try {
    console.log('4. Backend received request for /api/available-teams.');
    const availableTeams = await pool.query("SELECT team_id, city, name FROM teams WHERE user_id IS NULL");
    res.json(availableTeams.rows);
  } catch (error) {
    console.error('Error fetching available teams:', error);
    res.status(500).json({ message: 'Server error.' });
  }
});

// MAKE A SUBSTITUTION (Protected Route)
// MAKE A SUBSTITUTION (Protected Route)
app.post('/api/games/:gameId/substitute', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { playerInId, playerOutId, position } = req.body;
  const userId = req.user.userId;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    const currentState = stateResult.rows[0].state_data;
    const currentTurn = stateResult.rows[0].turn_number;

    let newState = JSON.parse(JSON.stringify(currentState));
    let logMessage = '';
    let playerInCard;

    // --- NEW: Generate Replacement Player if needed ---
    if (playerInId === 'replacement_hitter') {
        playerInCard = { 
            card_id: -1, name: 'Replacement Hitter', on_base: -10, speed: 'B', 
            fielding_ratings: { 'C': 0, '1B': 0, '2B': 0, 'SS': 0, '3B': 0, 'LF': 0, 'CF': 0, 'RF': 0 },
            chart_data: { '1-2': 'SO', '3-20': 'GB' }
        };
    } else if (playerInId === 'replacement_pitcher') {
        playerInCard = {
            card_id: -2, name: 'Replacement Pitcher', control: -1, ip: 1,
            chart_data: { '1-3': 'PU', '4-8': 'SO', '9-12': 'GB', '13-16': 'FB', '17':'BB', '18-19':'1B','20':'2B'}
        };
    } else {
        const playerInResult = await pool.query('SELECT * FROM cards_player WHERE card_id = $1', [playerInId]);
        playerInCard = playerInResult.rows[0];
    }

    const playerOutCard = await pool.query('SELECT * FROM cards_player WHERE card_id = $1', [playerOutId]);
    const teamKey = newState.homeTeam.lineup.some(p => p.card_id === playerOutId) ? 'homeTeam' : 'awayTeam';
    
    if (position === 'P') {
        newState[teamKey].currentPitcherId = playerInCard.card_id;
        logMessage = `${teamKey === 'homeTeam' ? 'Home' : 'Away'} brings in ${playerInCard.name} to relieve ${playerOutCard.rows[0].name}.`;
    } else {
        const lineup = newState[teamKey].lineup;
        const spotIndex = lineup.findIndex(spot => spot.card_id === playerOutId);
        if (spotIndex > -1) {
            lineup[spotIndex].card_id = playerInCard.card_id;
            logMessage = `${teamKey === 'homeTeam' ? 'Home' : 'Away'} substitutes ${playerInCard.name} for ${playerOutCard.rows[0].name}.`;
        }
    }

    await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
    await client.query('INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)', [gameId, userId, currentTurn + 1, 'substitution', logMessage]);
    
    await client.query('COMMIT');
    io.to(gameId).emit('game-updated');
    res.status(200).json({ message: 'Substitution successful.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error making substitution for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error during substitution.' });
  } finally {
    client.release();
  }
});

// SET DEFENSIVE STRATEGY (e.g., Infield In)
app.post('/api/games/:gameId/set-defense', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { infieldIn } = req.body; // Expecting { infieldIn: true } or { infieldIn: false }
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    let currentState = stateResult.rows[0].state_data;
    const currentTurn = stateResult.rows[0].turn_number;

    // Create a new state with the updated defensive setting
    const newState = { ...currentState, infieldIn: infieldIn };
    
    await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
    await client.query('COMMIT');
    
    // Notify the room that the game state has changed
    io.to(gameId).emit('game-updated');
    res.status(200).json({ message: 'Defensive strategy updated.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error setting defense:', error);
    res.status(500).json({ message: 'Server error while setting defense.' });
  } finally {
    client.release();
  }
});

// GET A SPECIFIC ROSTER AND ITS CARDS (Protected Route)
app.get('/api/rosters/:rosterId', authenticateToken, async (req, res) => {
  const { rosterId } = req.params;
  console.log(`5. Backend received request for roster ID: ${rosterId}`);
  try {
    const rosterCards = await pool.query(
      `SELECT cp.*, rc.is_starter, rc.assignment, cp.image_url FROM cards_player cp
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
// in server.js
// in server.js
app.get('/api/games/open', authenticateToken, async (req, res) => {
  try {
    const openGames = await pool.query(
      `SELECT g.game_id, t.city, t.name as team_name, u.user_id as host_user_id 
       FROM games g 
       JOIN game_participants gp ON g.game_id = gp.game_id
       JOIN users u ON gp.user_id = u.user_id
       JOIN teams t ON u.team_id = t.team_id
       WHERE g.status = 'pending' AND 
       (SELECT COUNT(*) FROM game_participants WHERE game_id = g.game_id) = 1`
    );
    res.json(openGames.rows);
  } catch (error) {
    console.error('Error fetching open games:', error);
    res.status(500).json({ message: 'Server error while fetching open games.' });
  }
});

// in server.js
// in server.js
app.get('/api/games', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const gamesResult = await pool.query(
      `SELECT g.game_id, g.status, g.current_turn_user_id 
       FROM games g JOIN game_participants gp ON g.game_id = gp.game_id 
       WHERE gp.user_id = $1 ORDER BY g.created_at DESC`,
      [userId]
    );

    // For each game, find the opponent and get their team info
    const gamesWithOpponent = [];
    for (const game of gamesResult.rows) {
        const opponentResult = await pool.query(
            `SELECT t.city, t.name as team_name 
             FROM game_participants gp 
             JOIN users u ON gp.user_id = u.user_id 
             JOIN teams t ON u.team_id = t.team_id 
             WHERE gp.game_id = $1 AND gp.user_id != $2`,
            [game.game_id, userId]
        );
        
        // ADD THIS DEBUG LOG
    console.log(`Debug for Game #${game.game_id}: Opponent query returned ${opponentResult.rows.length} rows.`);


        // Add opponent info to the game object, if an opponent exists
        const opponent = opponentResult.rows.length > 0 ? opponentResult.rows[0] : null;
        gamesWithOpponent.push({ ...game, opponent });
    }

    res.json(gamesWithOpponent);
  } catch (error) {
    console.error('Error fetching user games:', error);
    res.status(500).json({ message: 'Server error while fetching games.' });
  }
});

// GET ALL PLAYER CARDS (now processed)
app.get('/api/cards/player', authenticateToken, async (req, res) => {
    console.log('4. Backend received request for /api/cards/player.');
    try {
        const allCardsResult = await pool.query('SELECT * FROM cards_player ORDER BY name');
        const processedCards = processPlayers(allCardsResult.rows, allCardsResult.rows);
        res.json(processedCards);
    } catch (error) { res.status(500).json({ message: 'Server error fetching player cards.' }); }
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
        console.log(`1. BACKEND: Emitting 'games-updated' after creating game ${gameId}.`);
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
    const participantsQuery = await pool.query(
  `SELECT u.user_id, u.email, t.city, t.name, t.abbreviation, t.logo_url 
   FROM users u
   JOIN teams t ON u.team_id = t.team_id
   JOIN game_participants gp ON u.user_id = gp.user_id
   WHERE gp.game_id = $1`,
  [gameId]
);
    // --- THIS IS THE FIX ---
    // We now safely handle cases where display_format might be null
    const participants = participantsQuery.rows.map(p => {
        const format = p.display_format || '{city} {name}'; // Fallback to default
        p.full_display_name = format.replace('{city}', p.city).replace('{name}', p.name);
        return p;
    });

    const gameQuery = await pool.query('SELECT setup_rolls FROM games WHERE game_id = $1', [gameId]);
    res.json({
        rolls: gameQuery.rows[0]?.setup_rolls || {},
        participants: participants
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
        const joiningPlayerHomeOrAway = hostPlayerParticipant.home_or_away === 'home' ? 'away' : 'home';
        const joiningPlayerLeague = hostPlayerParticipant.league_designation === 'AL' ? 'NL' : 'AL';

        await client.query(`INSERT INTO game_participants (game_id, user_id, roster_id, home_or_away, league_designation) VALUES ($1, $2, $3, $4, $5)`, [gameId, joiningUserId, roster_id, joiningPlayerHomeOrAway, joiningPlayerLeague]);
        
        await client.query('COMMIT');
        io.emit('games-updated');
        res.json({ message: 'Successfully joined game.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Game join error:', error);
        res.status(500).json({ message: 'Server error while joining game.' });
    } finally {
        client.release();
    }
});

// GET A SPECIFIC GAME'S STATE (now processed)
// in server.js
app.get('/api/games/:gameId', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  try {
    const allCardsResult = await pool.query('SELECT name, team FROM cards_player');
    const gameResult = await pool.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
    if (gameResult.rows.length === 0) {
        return res.status(404).json({ message: 'Game not found.' });
    }
    const game = gameResult.rows[0];

    const participantsResult = await pool.query('SELECT * FROM game_participants WHERE game_id = $1', [gameId]);
    const teamsData = {};
    for (const p of participantsResult.rows) {
        const teamResult = await pool.query('SELECT * FROM teams WHERE user_id = $1', [p.user_id]);
        if (p.user_id === game.home_team_user_id) {
            teamsData.home = teamResult.rows[0];
        } else {
            teamsData.away = teamResult.rows[0];
        }
    }
    
    // If the game is pending, we can now safely return because we have the team data.
    if (game.status === 'pending') {
        return res.json({ game, gameState: null, gameEvents: [], batter: null, pitcher: null, lineups: {}, rosters: {}, teams: teamsData });
    }

    const stateResult = await pool.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    if (stateResult.rows.length === 0) {
        return res.status(404).json({ message: 'Game state not found.' });
    }
    const currentState = stateResult.rows[0];

    const eventsResult = await pool.query('SELECT * FROM game_events WHERE game_id = $1 ORDER BY "timestamp" ASC', [gameId]);
    
    let batter = null, pitcher = null, lineups = { home: null, away: null }, rosters = { home: [], away: [] };

    if (game.status === 'in_progress') {
        const activePlayers = await getActivePlayers(gameId, currentState.state_data);
        batter = activePlayers.batter;
        pitcher = activePlayers.pitcher;

        for (const p of participantsResult.rows) {
            const rosterCardsResult = await pool.query(`SELECT * FROM cards_player WHERE card_id = ANY(SELECT card_id FROM roster_cards WHERE roster_id = $1)`, [p.roster_id]);
            const fullRosterCards = rosterCardsResult.rows;
            if (p.lineup?.battingOrder) {
                const lineupWithDetails = p.lineup.battingOrder.map(spot => ({ ...spot, player: fullRosterCards.find(c => c.card_id === spot.card_id) }));
                const spCard = fullRosterCards.find(c => c.card_id === p.lineup.startingPitcher);
                processPlayers(lineupWithDetails.map(l => l.player), allCardsResult.rows);
                processPlayers(fullRosterCards, allCardsResult.rows);
                if (spCard) processPlayers([spCard], allCardsResult.rows);

                if (p.user_id === game.home_team_user_id) {
                    lineups.home = { battingOrder: lineupWithDetails, startingPitcher: spCard };
                    rosters.home = fullRosterCards;
                } else {
                    lineups.away = { battingOrder: lineupWithDetails, startingPitcher: spCard };
                    rosters.away = fullRosterCards;
                }
            }
        }
        if (batter) processPlayers([batter], allCardsResult.rows);
        if (pitcher) processPlayers([pitcher], allCardsResult.rows);
    }
    
    res.json({ game, gameState: currentState, gameEvents: eventsResult.rows, batter, pitcher, lineups, rosters, teams: teamsData });

  } catch (error) {
    console.error(`Error fetching game data for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error while fetching game data.' });
  }
});

// in server.js
app.post('/api/games/:gameId/pitch', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { action } = req.body;
  const userId = req.user.userId;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    let currentState = stateResult.rows[0].state_data;
    const currentTurn = stateResult.rows[0].turn_number;

    const { batter, pitcher, offensiveTeam, defensiveTeam } = await getActivePlayers(gameId, currentState);
    
    // Get all players for context and process the batter to get their displayName
    const allCardsResult = await pool.query('SELECT name, team FROM cards_player');
    processPlayers([batter, pitcher], allCardsResult.rows);
    
    // --- Pitcher Fatigue Logic ---
    const pitcherId = pitcher.card_id;
    
    // FIX: Add this block to safely initialize pitcherStats if it doesn't exist
    if (!currentState.pitcherStats) {
        currentState.pitcherStats = {};
    }

    let stats = currentState.pitcherStats[pitcherId];
    
    if (!stats) {
        stats = { ip: 0, runs: 0 };
    }
    
    // A new inning for the pitcher starts when they face the first batter of an inning
    if (currentState.outs === 0 && (
        (currentState.isTopInning && currentState.awayTeam.battingOrderPosition === 0) ||
        (!currentState.isTopInning && currentState.homeTeam.battingOrderPosition === 0)
    )) {
      stats.ip++;
    }

    let controlPenalty = 0;
    const fatigueThreshold = pitcher.ip - Math.floor(stats.runs / 3);
    if (stats.ip > fatigueThreshold) {
        controlPenalty = stats.ip - fatigueThreshold;
    }
    const effectiveControl = pitcher.control - controlPenalty;
    // --- End of Fatigue Logic ---

    if (action === 'intentional_walk') {
        const { newState, events } = applyOutcome(currentState, 'BB', batter, pitcher);
        
        const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
      newState[offensiveTeamKey].battingOrderPosition = (newState[offensiveTeamKey].battingOrderPosition + 1) % 9;
      
        newState.atBatStatus = 'pitching';
        await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
        for (const logMessage of events) { 
          await client.query(
            `INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)`,
            [gameId, userId, currentTurn + 1, 'walk', logMessage]
          );
        }
        await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [defensiveTeam.user_id, gameId]);
    } else {
        const pitchRoll = Math.floor(Math.random() * 20) + 1;
        const advantageCheck = pitchRoll + effectiveControl;
        const advantage = advantageCheck > batter.on_base ? 'pitcher' : 'batter';
        
        const newState = { ...currentState };
        newState.atBatStatus = 'swinging';
        newState.pitchRollResult = { roll: pitchRoll, advantage: advantage, penalty: controlPenalty };
        newState.swingRollResult = null; // Clear old swing result
        newState.stealRollResult = null; // Clear old steal result
        newState.pitcherStats[pitcherId] = stats;
        
        await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
        
// ADD THESE DEBUG LOGS
console.log('--- PITCH ENDPOINT DEBUG ---');
console.log('Attempting to pass turn to offensive team...');
console.log('Offensive Team Object:', JSON.stringify(offensiveTeam));
console.log('Value being passed as next turn ID:', offensiveTeam.user_id);

await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [offensiveTeam.user_id, gameId]);
    }
    
    await client.query('COMMIT');
    io.to(gameId).emit('game-updated');
    res.status(200).json({ message: 'Pitch action complete.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during pitch:', error);
    res.status(500).json({ message: 'Server error during pitch.' });
  } finally {
    client.release();
  }
});

// in server.js

// STEP 2 OF AT-BAT: SWING
// in server.js
// in server.js
// in server.js
app.post('/api/games/:gameId/swing', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { action } = req.body;
  const userId = req.user.userId;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    const currentStateData = stateResult.rows[0].state_data;
    const currentTurn = stateResult.rows[0].turn_number;

    const { batter, pitcher, defensiveTeam } = await getActivePlayers(gameId, currentStateData);
    
    const allCardsResult = await pool.query('SELECT name, team FROM cards_player');
    processPlayers([batter], allCardsResult.rows);
    
    let outcome = 'OUT';
    let swingRoll = 0;
    let infieldDefense = 0; // Initialize infield defense

    if (action === 'bunt') {
        outcome = 'SAC BUNT';
    } else {
        swingRoll = Math.floor(Math.random() * 20) + 1;
        const chartHolder = currentStateData.pitchRollResult.advantage === 'pitcher' ? pitcher : batter;
        for (const range in chartHolder.chart_data) {
            const [min, max] = range.split('-').map(Number);
            if (swingRoll >= min && swingRoll <= max) {
                outcome = chartHolder.chart_data[range];
                break;
            }
        }
    }
    
    // If the outcome is a ground ball, get the infield defense rating
    if (outcome.includes('GB')) {
        infieldDefense = await getInfieldDefense(defensiveTeam);
    }

    const wasTopInning = currentStateData.isTopInning;
    const { newState, events } = applyOutcome(currentStateData, outcome, batter, pitcher, infieldDefense);
    
    // --- THIS IS THE FIX ---
  // Advance the batter in the order now that the at-bat is resolved.
  if (!newState.atBatStatus?.includes('decision')&&wasTopInning === newState.isTopInning) {
    const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
    newState[offensiveTeamKey].battingOrderPosition = (newState[offensiveTeamKey].battingOrderPosition + 1) % 9;
  }

    const finalState = { 
        ...newState, 
        pitchRollResult: currentStateData.pitchRollResult,
        swingRollResult: { roll: swingRoll, outcome: outcome }
    };

    if (finalState.gameOver) {
        await client.query(`UPDATE games SET status = 'completed', completed_at = NOW(), current_turn_user_id = NULL WHERE game_id = $1`, [gameId]);
    } else if (!['offensive-baserunning-decision', 'tag-up-decision', 'infield-in-decision'].includes(finalState.atBatStatus)) {
        finalState.atBatStatus = 'pitching';
        
        // This is the key fix: determine the NEXT defensive player based on the NEW state
        const game = await client.query('SELECT home_team_user_id FROM games WHERE game_id = $1', [gameId]);
        const participants = await client.query('SELECT user_id FROM game_participants WHERE game_id = $1', [gameId]);
        const homePlayerId = game.rows[0].home_team_user_id;
        const awayPlayerId = participants.rows.find(p => p.user_id !== homePlayerId).user_id;
        
        const nextTurnUserId = finalState.isTopInning ? homePlayerId : awayPlayerId;
        await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [nextTurnUserId, gameId]);
    }

    await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, finalState]);
    
    for (const event of events) {
      let logMessage = event.message;
      
      if (event.scoreChanged) {
          logMessage += ` <strong>(Score: ${newState.awayScore}-${newState.homeScore})</strong>`;
      }
      if (event.outsChanged) {
          logMessage += ` (Outs: ${newState.outs})`;
      }
      if (event.isNewInning) {
          const newPitcher = await getActivePlayers(gameId, newState).then(p => p.pitcher);
          logMessage += ` (Now Pitching: ${newPitcher.name})`;
      }

      await client.query(
        `INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)`,
        [gameId, userId, currentTurn + 1, 'game_event', logMessage]
      );
  }

    await client.query('COMMIT');
    io.to(gameId).emit('game-updated');
    res.status(200).json({ message: 'At-bat complete.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error during swing for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error during swing.' });
  } finally {
    client.release();
  }
});

// in server.js
app.post('/api/games/:gameId/reset-rolls', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  try {
    // Set the setup_rolls column back to an empty object
    await pool.query(`UPDATE games SET setup_rolls = '{}'::jsonb WHERE game_id = $1`, [gameId]);
    
    // Notify both players that the rolls have been updated (cleared)
    io.to(gameId).emit('roll-updated');
    res.sendStatus(200);
  } catch (error) {
    console.error(`Error resetting rolls for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error while resetting rolls.' });
  }
});


// OFFENSE declares which runners to send
// in server.js
// in server.js
app.post('/api/games/:gameId/submit-decisions', authenticateToken, async (req, res) => {
    const { gameId } = req.params;
    const { decisions } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
        let newState = stateResult.rows[0].state_data;
        const currentTurn = stateResult.rows[0].turn_number;
        const { defensiveTeam } = await getActivePlayers(gameId, newState);

        const runnersWereSent = Object.values(decisions).some(sent => sent);

        if (runnersWereSent) {
            // If runners were sent, proceed to the defensive decision
            newState.currentPlay.choices = decisions;
            newState.atBatStatus = 'defensive-throw-decision';
            await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [defensiveTeam.user_id, gameId]);
        } else {
            // If no runners were sent, the play is over. Finalize the turn.
            newState.atBatStatus = 'pitching';
            const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
            newState[offensiveTeamKey].battingOrderPosition = (newState[offensiveTeamKey].battingOrderPosition + 1) % 9;
            await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [defensiveTeam.user_id, gameId]);
        }
        
        // Clear the decision-making part of the play
        newState.currentPlay.decisions = []; 
        await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
        
        await client.query('COMMIT');
        io.to(gameId).emit('game-updated');
        res.sendStatus(200);
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error submitting decisions for game ${gameId}:`, error);
        res.status(500).json({ message: 'Server error during decision submission.' });
    } finally {
        client.release();
    }
});

// in server.js
app.post('/api/games/:gameId/resolve-throw', authenticateToken, async (req, res) => {
    const { gameId } = req.params;
    const { throwTo } = req.body;
    const userId = req.user.userId;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
        let newState = stateResult.rows[0].state_data;
        const currentTurn = stateResult.rows[0].turn_number;
        const { defensiveTeam } = await getActivePlayers(gameId, newState);
        const events = [];

        const isSteal = newState.currentPlay.hitType === 'STEAL';
        let defenseTotal = 0;

        if (isSteal) {
            const catcherInfo = defensiveTeam.lineup.battingOrder.find(p => p.position === 'C');
            const catcherCard = await pool.query('SELECT fielding_ratings FROM cards_player WHERE card_id = $1', [catcherInfo.card_id]);
            const catcherArm = catcherCard.rows[0].fielding_ratings['C'] || 0;
            defenseTotal = catcherArm + Math.floor(Math.random() * 20) + 1;
        } else {
            const outfieldDefense = await getOutfieldDefense(defensiveTeam);
            defenseTotal = outfieldDefense + Math.floor(Math.random() * 20) + 1;
        }
        const scoreKey = newState.isTopInning ? 'awayScore' : 'homeScore';
        
        const choices = newState.currentPlay.choices;
        const baseMap = { 1: 'first', 2: 'second', 3: 'third' };

        // 1. Resolve all "unchallenged" advances first
        for (const fromBaseStr in choices) {
            if (choices[fromBaseStr] && parseInt(fromBaseStr, 10) !== throwTo - 1) {
                const fromBase = parseInt(fromBaseStr, 10);
                const runner = newState.bases[baseMap[fromBase]];
                if(runner) {
                    if (fromBase === 3) { newState[scoreKey]++; newState.bases.third = null; }
                    if (fromBase === 2) { newState.bases.third = runner; newState.bases.second = null; }
                    if (fromBase === 1) { newState.bases.second = runner; newState.bases.first = null; }
                    events.push(`${runner.runner.name} advances safely.`);
                }
            }
        }

        // 2. Resolve the "challenged" throw
        const challengedBase = throwTo - 1;
        const runner = newState.bases[baseMap[challengedBase]];
        if (runner) {
            const throwRoll = Math.floor(Math.random() * 20) + 1;
            let speed = runner.runner.speed;
            if (challengedBase === 3) speed += 5; // Going home
            if (challengedBase === 1) speed -= 5; // Tagging to 2nd
            
            const defenseTotal = outfieldDefense + throwRoll;

            if (speed > defenseTotal) { // SAFE
                if (challengedBase === 3) { newState[scoreKey]++; newState.bases.third = null; }
                if (challengedBase === 2) { newState.bases.third = runner; newState.bases.second = null; }
                if (challengedBase === 1) { newState.bases.second = runner; newState.bases.first = null; }
                events.push(`${runner.runner.name} is SAFE at ${throwTo}B!`);
            } else { // OUT
                newState.outs++;
                newState.bases[baseMap[challengedBase]] = null;
                events.push(`${runner.runner.name} is THROWN OUT at ${throwTo}B!`);
            }
        }

        // 3. Finalize the turn state
        newState.atBatStatus = 'pitching';
        newState.currentPlay = null;
        // On a steal, the batter does NOT advance. On other plays, they do.
        if (!isSteal) {
            const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
            newState[offensiveTeamKey].battingOrderPosition = (newState[offensiveTeamKey].battingOrderPosition + 1) % 9;
        }

        if (newState.outs >= 3) {
          newState.isTopInning = !newState.isTopInning;
      if (newState.isTopInning) newState.inning++;
      newState.outs = 0;
      newState.bases = { first: null, second: null, third: null };
      events.push(`--- ${newState.isTopInning ? 'Top' : 'Bottom'} of the ${newState.inning} ---`);
        }

        await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
        for (const logMessage of events) {
            await client.query(`INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)`, [gameId, userId, currentTurn + 1, 'baserunning', logMessage]);
        }
        // On a steal, turn goes back to the pitcher.
        const pitcherId = defensiveTeam.userId;
        
        await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [defensiveTeam.userId, gameId]);
        await client.query('COMMIT');
        
        io.to(gameId).emit('game-updated');
        res.sendStatus(200);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error resolving throw for game ${gameId}:`, error);
        res.status(500).json({ message: 'Server error during throw resolution.' });
    } finally {
        client.release();
    }
});

// in server.js
app.post('/api/games/:gameId/infield-in-play', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { sendRunner } = req.body; // boolean
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    let currentState = stateResult.rows[0].state_data;
    const currentTurn = stateResult.rows[0].turn_number;
    const { defensiveTeam } = await getActivePlayers(gameId, currentState);
    const infieldDefense = await getInfieldDefense(defensiveTeam);

    const events = [];
    let newState = JSON.parse(JSON.stringify(currentState));
    const runner = newState.infieldInDecision.runner;
    const batter = newState.infieldInDecision.batter;
    const scoreKey = newState.isTopInning ? 'awayScore' : 'homeScore';

    if (sendRunner) {
      const throwRoll = Math.floor(Math.random() * 20) + 1;
      const defenseTotal = infieldDefense + throwRoll;
      if (runner.speed > defenseTotal) {
        // SAFE at home, batter safe at first
        events.push(`${runner.name} is SENT HOME... and scores! Batter reaches on a fielder's choice.`);
        newState[scoreKey]++;
        newState.bases.third = null;
        newState.bases.first = batter;
      } else {
        // OUT at home, batter safe at first
        events.push(`${runner.name} is THROWN OUT at the plate! Batter reaches on a fielder's choice.`);
        newState.outs++;
        newState.bases.third = null;
        newState.bases.first = batter;
      }
    } else {
      // HOLD runner
      events.push(`The runner holds at third. ${batter.name} is out at first.`);
      newState.outs++;
    }

    newState.atBatStatus = 'pitching';
    newState.infieldInDecision = null;
    const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
    newState[offensiveTeamKey].battingOrderPosition = (newState[offensiveTeamKey].battingOrderPosition + 1) % 9;
    
    if (newState.outs >= 3) { 
      const wasTop = newState.isTopInning;
      newState.isTopInning = !newState.isTopInning;
      if (newState.isTopInning) newState.inning++;
      newState.outs = 0;
      newState.bases = { first: null, second: null, third: null };
      if (newState.inning <= 9 || (newState.inning > 9 && wasTop)) {
        events.push(`--- ${newState.isTopInning ? 'Top' : 'Bottom'} of the ${newState.inning} ---`);
      }
    }

    await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
    for (const logMessage of events) {
      // FIX 2: Added the user_id back into the event log query.
      await client.query(
        `INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)`,
        [gameId, userId, currentTurn + 1, 'tag-up', logMessage]
      );
    }
    await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [defensiveTeam.userId, gameId]);
    await client.query('COMMIT');
    
    io.to(gameId).emit('game-updated');
    res.sendStatus(200);
  } catch (error) { /* ... */ } 
  finally { client.release(); }
});

// in server.js
app.post('/api/games/:gameId/tag-up', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { decisions } = req.body;
  const userId = req.user.userId; // Get the current user's ID
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    let currentState = stateResult.rows[0].state_data;
    const currentTurn = stateResult.rows[0].turn_number;

    const { defensiveTeam } = await getActivePlayers(gameId, currentState);
    const outfieldDefense = await getOutfieldDefense(defensiveTeam);

    const events = [];
    let newState = JSON.parse(JSON.stringify(currentState));
    const scoreKey = newState.isTopInning ? 'awayScore' : 'homeScore'; // Define the score key

    // Resolve each tag-up decision
    for (const fromBaseStr in decisions) {
        if (decisions[fromBaseStr]) {
            const fromBase = parseInt(fromBaseStr, 10);
            const baseMap = { 3: 'third', 2: 'second', 1: 'first' };
            const runner = newState.bases[baseMap[fromBase]];
            
            if (!runner) continue;

            const throwRoll = Math.floor(Math.random() * 20) + 1;
            let speed = runner.speed;
            
            if (fromBase === 3) speed += 5;
            if (fromBase === 1) speed -= 5;
            
            const defenseTotal = outfieldDefense + throwRoll;

            if (speed > defenseTotal) {
                // SAFE
                // FIX 1: Use the dynamic scoreKey to award the run to the correct team.
                if (fromBase === 3) { newState[scoreKey]++; newState.bases.third = null; }
                if (fromBase === 2) { newState.bases.third = runner; newState.bases.second = null; }
                if (fromBase === 1) { newState.bases.second = runner; newState.bases.first = null; }
                events.push(`${runner.name} tags up and is SAFE!`);
            } else {
                // OUT
                newState.outs++;
                newState.bases[baseMap[fromBase]] = null;
                events.push(`${runner.name} is THROWN OUT trying to tag up!`);
            }
        }
    }
    
    newState.atBatStatus = 'pitching';
    newState.tagUpDecisions = null;

    const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
    newState[offensiveTeamKey].battingOrderPosition = (newState[offensiveTeamKey].battingOrderPosition + 1) % 9;

    if (newState.outs >= 3) { 
      const wasTop = newState.isTopInning;
      newState.isTopInning = !newState.isTopInning;
      if (newState.isTopInning) newState.inning++;
      newState.outs = 0;
      newState.bases = { first: null, second: null, third: null };
      if (newState.inning <= 9 || (newState.inning > 9 && wasTop)) {
        events.push(`--- ${newState.isTopInning ? 'Top' : 'Bottom'} of the ${newState.inning} ---`);
      }
    }
    
    await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
    for (const logMessage of events) {
      // FIX 2: Added the user_id back into the event log query.
      await client.query(
        `INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)`,
        [gameId, userId, currentTurn + 1, 'tag-up', logMessage]
      );
    }
    await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [defensiveTeam.userId, gameId]);
    await client.query('COMMIT');
    
    io.to(gameId).emit('game-updated');
    res.sendStatus(200);

  } catch (error) { 
    await client.query('ROLLBACK');
    console.error(`Error with tag-ups for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error during tag-up.' }); 
  } finally { 
    client.release(); 
  }
});

// in server.js
app.post('/api/games/:gameId/initiate-steal', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { fromBase } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    let newState = stateResult.rows[0].state_data;
    const currentTurn = stateResult.rows[0].turn_number;

    const { defensiveTeam } = await getActivePlayers(gameId, newState);
    
    // Set the game state to pause for the defensive throw
    newState.atBatStatus = 'defensive-steal-throw';
    newState.stealAttempt = { from: fromBase, runner: newState.bases[fromBase === 1 ? 'first' : 'second'] };
    
    // Pass the turn to the defensive player
    await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [defensiveTeam.user_id, gameId]);
    await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
    
    await client.query('COMMIT');
    io.to(gameId).emit('game-updated');
    res.sendStatus(200);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error initiating steal for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error during steal initiation.' });
  } finally {
    client.release();
  }
});

// in server.js
app.post('/api/games/:gameId/resolve-steal', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const userId = req.user.userId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    
    const originalState = stateResult.rows[0].state_data;

    // ADD THIS DEBUG LOG
    console.log('--- FULL STATE ON STEAL RESOLUTION ---');
    console.log(JSON.stringify(originalState, null, 2));

    const currentTurn = stateResult.rows[0].turn_number;
    let newState = JSON.parse(JSON.stringify(originalState));
    
    const { offensiveTeam, defensiveTeam } = await getActivePlayers(gameId, newState);
    const { fromBase, runner } = newState.stealAttempt;

    const catcherInfo = defensiveTeam.lineup.battingOrder.find(p => p.position === 'C');
    const catcherCard = await pool.query('SELECT fielding_ratings FROM cards_player WHERE card_id = $1', [catcherInfo.card_id]);
    const catcherArm = catcherCard.rows[0].fielding_ratings['C'] || 0;
    
    const throwRoll = Math.floor(Math.random() * 20) + 1;
    const catcherTotal = catcherArm + throwRoll;
    const isSafe = runner.speed > catcherTotal;
    
    const events = [];
    const baseMap = { 1: 'first', 2: 'second' };
    
    // --- FINAL DEBUG LOGS ---
    console.log('--- RESOLVE STEAL DEBUG ---');
    console.log(`Steal from base ${fromBase}. Runner is ${runner.name}. Outcome: ${isSafe ? 'SAFE' : 'OUT'}`);
    
    const newBases = { ...newState.bases };
    newBases[baseMap[fromBase]] = null;

    if (isSafe) {
      console.log(`Runner was SAFE. Moving from ${baseMap[fromBase]}...`);
      if (fromBase === 1) newBases.second = runner;
      if (fromBase === 2) newBases.third = runner;
      events.push(`${runner.name} steals and is SAFE! (Speed ${runner.speed} vs. Throw ${catcherTotal})`);
      console.log('Bases object after moving runner:', JSON.stringify(newBases));
    } else {
      newState.outs++;
      events.push(`${runner.name} is CAUGHT STEALING! (Speed ${runner.speed} vs. Throw ${catcherTotal})`);
    }
    
    newState.bases = newBases;
    newState.atBatStatus = 'pitching';
    newState.stealAttempt = null;
    newState.stealRollResult = { catcherArm, throwRoll, total: catcherTotal, outcome: isSafe ? 'Safe' : 'Out' };
    
    if (newState.outs >= 3) {
        const wasTop = newState.isTopInning;
        newState.isTopInning = !newState.isTopInning;
        if (newState.isTopInning) newState.inning++;
        newState.outs = 0;
        newState.bases = { first: null, second: null, third: null };
        events.push(`--- ${newState.isTopInning ? 'Top' : 'Bottom'} of the ${newState.inning} ---`);
    }

    console.log('Final Bases to be Saved:', JSON.stringify(newState.bases));
    
    await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
    for (const logMessage of events) {
        await client.query(`INSERT INTO game_events (game_id, user_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4, $5)`, [gameId, offensiveTeam.user_id, currentTurn + 1, 'steal', logMessage]);
    }
    
    await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [defensiveTeam.user_id, gameId]);
    await client.query('COMMIT');
    
    io.to(gameId).emit('game-updated');
    res.status(200).json({ message: 'Steal resolved.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error resolving steal for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error during steal.' });
  } finally {
    client.release();
  }
});

// in server.js
app.post('/api/games/:gameId/advance-runners', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { decisions } = req.body; // e.g., { '1': true, '2': false }
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
    let currentState = stateResult.rows[0].state_data;
    const currentTurn = stateResult.rows[0].turn_number;

    const { defensiveTeam } = await getActivePlayers(gameId, currentState);
    const outfieldDefense = await getOutfieldDefense(defensiveTeam);

    const events = [];
    let newState = JSON.parse(JSON.stringify(currentState));

    // Resolve each baserunning decision
    for (const fromBase in decisions) {
      if (decisions[fromBase]) { // If the manager chose to send this runner
        const runner = fromBase === '1' ? newState.bases.first : newState.bases.second;
        if (!runner) continue;

        const throwRoll = Math.floor(Math.random() * 20) + 1;
        let speed = runner.speed;
        
        // Apply modifiers
        if (newState.outs === 2) speed += 5;
        if (fromBase === '2') speed += 5; // Runner from 2nd is trying to score (going home)
        
        const defenseTotal = outfieldDefense + throwRoll;

        if (speed > defenseTotal) {
          // SAFE!
          if (fromBase === '1') { newState.bases.third = runner; newState.bases.first = null; }
          if (fromBase === '2') { newState[newState.isTopInning ? 'awayScore' : 'homeScore']++; newState.bases.second = null; }
          events.push(`${runner.name} advances an extra base and is SAFE! (Speed ${speed} vs Defense ${defenseTotal})`);
        } else {
          // OUT!
          newState.outs++;
          if (fromBase === '1') newState.bases.first = null;
          if (fromBase === '2') newState.bases.second = null;
          events.push(`${runner.name} is THROWN OUT trying to advance! (Speed ${speed} vs Defense ${defenseTotal})`);
        }
      }
    }
    
    // Finalize the turn
    newState.atBatStatus = 'pitching';
    newState.baserunningDecisions = null;
    const offensiveTeamKey = newState.isTopInning ? 'awayTeam' : 'homeTeam';
    newState[offensiveTeamKey].battingOrderPosition = (newState[offensiveTeamKey].battingOrderPosition + 1) % 9;
    
    // Check for inning end after the play
    if (newState.outs >= 3) {
      newState.isTopInning = !newState.isTopInning;
      if (newState.isTopInning) newState.inning++;
      newState.outs = 0;
      newState.bases = { first: null, second: null, third: null };
      events.push(`--- ${newState.isTopInning ? 'Top' : 'Bottom'} of the ${newState.inning} ---`);
    }

    await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
    for (const logMessage of events) {
      await client.query(`INSERT INTO game_events (game_id, turn_number, event_type, log_message) VALUES ($1, $2, $3, $4)`, [gameId, currentTurn + 1, 'baserunning', logMessage]);
    }
    await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [defensiveTeam.userId, gameId]);
    await client.query('COMMIT');
    
    io.to(gameId).emit('game-updated');
    res.sendStatus(200);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`Error advancing runners for game ${gameId}:`, error);
    res.status(500).json({ message: 'Server error during baserunning.' });
  } finally {
    client.release();
  }
});

// GET A USER'S PARTICIPANT INFO FOR A SPECIFIC GAME
// in server.js
app.get('/api/games/:gameId/my-roster', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const userId = req.user.userId;
  try {
    // Step 1: Find the user's roster_id for this specific game.
    const participantResult = await pool.query(
      `SELECT roster_id FROM game_participants WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId]
    );

    if (participantResult.rows.length === 0) {
      return res.status(404).json({ message: 'You are not a participant in this game.' });
    }
    const rosterId = participantResult.rows[0].roster_id;

    // Step 2: Now that we have the roster_id, we can return it.
    // The SetLineupView will use this ID to call the /api/rosters/:rosterId endpoint.
    res.json({ roster_id: rosterId });

  } catch (error) {
    console.error(`Error fetching participant info for game ${gameId}:`, error);
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