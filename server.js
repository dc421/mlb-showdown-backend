// server.js

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); // Add this line
const authenticateToken = require('./middleware/authenticateToken'); // Add this import at the top

// --- Basic Setup ---
const app = express();
const PORT = process.env.PORT || 3001; // Use port from .env or default to 3001
const fs = require('fs');
const csv = require('csv-parser');

// TEMPORARY: Endpoint to populate the database
app.get('/api/setup/ingest-data-12345', async (req, res) => {
    // ingest-data.js
    
    // Load environment variables from .env file
    require('dotenv').config(); 
    
    const fs = require('fs');
    const csv = require('csv-parser');
    const { Pool } = require('pg');
    
    // Create a new PostgreSQL connection pool using credentials from .env
    const pool = new Pool({
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_DATABASE,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT,
    });
    
    /**
     * Transforms a player's outcome stats into a JSONB chart object.
     * This function assumes a linear mapping of d20 rolls. For example, if a
     * player has SO=3, GB=7, we map rolls 1-3 to SO and 4-10 to GB.
     * You may need to adjust this logic if the official rules are different.
     */
    function createChartData(row, isPitcher = false) {
      const chart = {};
      let currentRoll = 1;
    
      // Define the outcome columns in the order they appear on the chart
      const outcomes = isPitcher 
        ? ['PU', 'SO', 'GB', 'FB', 'BB', '1B', '2B', 'HR']
        : ['SO', 'GB', 'FB', 'BB', '1B', '1B+', '2B', '3B', 'HR'];
    
      outcomes.forEach(outcome => {
        const value = parseInt(row[outcome], 10);
        if (value > 0) {
          const endRoll = currentRoll + value - 1;
          chart[`${currentRoll}-${endRoll}`] = outcome;
          currentRoll = endRoll + 1;
        }
      });
    
      return chart;
    }
    
    
    async function processFile(filePath, isPitcher = false) {
      const records = [];
      
      // Read the CSV file row by row
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          // For each row, create a player card object matching our database schema
          const card = {
            name: `${row.First} ${row.Last}`,
            team: row.Tm,
            year: 2001, // Assuming all cards are from the 2001 set
            points: parseInt(row.Pts, 10),
            on_base: isPitcher ? null : parseInt(row.OB, 10),
            control: isPitcher ? parseInt(row.Ctl, 10) : null,
            ip: isPitcher ? parseInt(row.IP, 10) : null,
            speed: isPitcher ? null : row.Spd,
            fielding: isPitcher ? null : parseInt(row.Fld, 10),
            positions: isPitcher ? 'P' : row.Pos,
            chart_data: createChartData(row, isPitcher),
          };
          records.push(card);
        })
        .on('end', async () => {
          console.log(`Finished reading ${filePath}. Found ${records.length} records. Inserting into database...`);
    
          // Once the file is read, insert all records into the database
          const client = await pool.connect();
          try {
            // Begin a transaction
            await client.query('BEGIN');
    
            for (const record of records) {
              const insertQuery = `
                INSERT INTO cards_player (name, team, year, points, on_base, control, ip, speed, fielding, positions, chart_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              `;
              const values = [
                record.name, record.team, record.year, record.points, record.on_base, record.control, 
                record.ip, record.speed, record.fielding, record.positions, record.chart_data
              ];
              await client.query(insertQuery, values);
            }
            
            // Commit the transaction
            await client.query('COMMIT');
            console.log(`Successfully inserted ${records.length} records from ${filePath}.`);
          } catch (e) {
            // If an error occurs, roll back the transaction
            await client.query('ROLLBACK');
            console.error(`Error inserting data from ${filePath}:`, e);
          } finally {
            // Release the client back to the pool
            client.release();
          }
        });
    }
    
    async function main() {
      console.log("Starting data ingestion process...");
      await processFile('hitters.csv', false);
      await processFile('pitchers.csv', true);
      // Note: The script will exit once the file reading streams are complete.
      // We add a small delay here to allow database insertions to finish logging before we consider closing the pool.
      setTimeout(() => {
        console.log("Ingestion process initiated for all files. Check console for completion status.");
        // In a real app you'd handle this more gracefully, but for a one-off script this is fine.
        // pool.end(); // Uncomment if you want the script to automatically exit after a few seconds.
      }, 5000);
    }
    
    main();
    res.send("This endpoint would trigger data ingestion.");
});

// --- Database Connection ---
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// --- Middleware ---
app.use(cors());          // Enable Cross-Origin Resource Sharing
app.use(express.json());  // Enable parsing of JSON request bodies

// --- API Routes ---

// USER REGISTRATION
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;

  // Basic validation
  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email, and password are required.' });
  }

  try {
    // 1. Check if user already exists
    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1 OR email = $2', [username, email]);
    if (userCheck.rows.length > 0) {
      return res.status(409).json({ message: 'Username or email already exists.' });
    }

    // 2. Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // 3. Insert the new user into the database
    const newUser = await pool.query(
      'INSERT INTO users (username, email, hashed_password) VALUES ($1, $2, $3) RETURNING user_id, username, email',
      [username, email, hashedPassword]
    );

    // 4. Send back a success response
    res.status(201).json({
      message: 'User registered successfully!',
      user: newUser.rows[0],
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'An error occurred on the server.' });
  }
});

// USER LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    // 1. Find the user by email
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials.' }); // Use a generic message for security
    }

    const user = userResult.rows[0];

    // 2. Compare the submitted password with the stored hash
    const isMatch = await bcrypt.compare(password, user.hashed_password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    // 3. If passwords match, create a JWT
    const payload = {
      userId: user.user_id,
      username: user.username,
    };

    const token = jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '3h' } // Token expires in 3 hours
    );

    // 4. Send the token back to the client
    res.json({
      message: 'Logged in successfully!',
      token: token,
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'An error occurred on the server.' });
  }
});

// CREATE A NEW ROSTER (Protected Route)
app.post('/api/rosters', authenticateToken, async (req, res) => {
  const { roster_name, card_ids } = req.body;
  const userId = req.user.userId; // We get this from the authenticateToken middleware

  // 1. Validate the roster rules
  if (!roster_name || !card_ids || card_ids.length !== 20) {
    return res.status(400).json({ message: 'Roster must have a name and exactly 20 cards.' });
  }

  const client = await pool.connect();
  try {
    // 2. Get card data and calculate total points
    const cardsQuery = await client.query('SELECT card_id, points FROM cards_player WHERE card_id = ANY($1::int[])', [card_ids]);
    
    if (cardsQuery.rows.length !== 20) {
        return res.status(400).json({ message: 'One or more invalid card IDs were provided.' });
    }
    
    const totalPoints = cardsQuery.rows.reduce((sum, card) => sum + card.points, 0);

    if (totalPoints > 5000) {
      return res.status(400).json({ message: `Roster is over the 5000 point limit. Total: ${totalPoints}` });
    }

    // 3. Use a transaction to create the roster and add cards
    await client.query('BEGIN');

    // Insert into the main rosters table
    const newRoster = await client.query(
      'INSERT INTO rosters (user_id, roster_name) VALUES ($1, $2) RETURNING roster_id',
      [userId, roster_name]
    );
    const rosterId = newRoster.rows[0].roster_id;

    // Insert all 20 cards into the roster_cards join table
    for (const cardId of card_ids) {
      await client.query('INSERT INTO roster_cards (roster_id, card_id) VALUES ($1, $2)', [rosterId, cardId]);
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

// A simple test route to make sure the server is working
app.get('/api/test', async (req, res) => {
  try {
    // Test database connection
    const dbTime = await pool.query('SELECT NOW()');
    res.json({
      message: 'API server is running and connected to the database!',
      dbTime: dbTime.rows[0].now,
    });
  } catch (error) {
    console.error('Database connection test failed:', error);
    res.status(500).json({ message: 'Error connecting to the database.' });
  }
});

// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// CREATE A NEW GAME (Protected Route)
app.post('/api/games', authenticateToken, async (req, res) => {
  const { roster_id, home_or_away, league_designation } = req.body;
  const userId = req.user.userId;

  if (!roster_id || !home_or_away || !league_designation) {
    return res.status(400).json({ message: 'roster_id, home_or_away, and league_designation are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Create a new game record
    const newGame = await client.query(
      `INSERT INTO games (status) VALUES ('pending') RETURNING game_id`
    );
    const gameId = newGame.rows[0].game_id;

    // 2. Add the creator as the first participant
    await client.query(
      `INSERT INTO game_participants (game_id, user_id, roster_id, home_or_away, league_designation)
       VALUES ($1, $2, $3, $4, $5)`,
      [gameId, userId, roster_id, home_or_away, league_designation]
    );
    
    await client.query('COMMIT');
    res.status(201).json({ message: 'Game created and waiting for an opponent.', gameId: gameId });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Game creation error:', error);
    res.status(500).json({ message: 'Server error during game creation.' });
  } finally {
    client.release();
  }
});

// JOIN AN EXISTING GAME (Protected Route)
app.post('/api/games/:gameId/join', authenticateToken, async (req, res) => {
  const { gameId } = req.params;
  const { roster_id } = req.body;
  const joiningUserId = req.user.userId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get the game and the first participant's details
    const gameResult = await client.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
    if (gameResult.rows.length === 0) {
      return res.status(404).json({ message: 'Game not found.' });
    }
    if (gameResult.rows[0].status !== 'pending') {
      return res.status(400).json({ message: 'This game is not available to join.' });
    }

    const participantsResult = await client.query('SELECT * FROM game_participants WHERE game_id = $1', [gameId]);
    if (participantsResult.rows.length >= 2) {
      return res.status(400).json({ message: 'This game is already full.' });
    }
    if (participantsResult.rows[0].user_id === joiningUserId) {
        return res.status(400).json({ message: 'You cannot join your own game.' });
    }
    
    const hostPlayer = participantsResult.rows[0];

    // 2. Add the joining player as the second participant
    const joiningPlayerHomeOrAway = hostPlayer.home_or_away === 'home' ? 'away' : 'home';
    const joiningPlayerLeague = hostPlayer.league_designation === 'AL' ? 'NL' : 'AL'; // Assign opposite league for simplicity
    
    await client.query(
        `INSERT INTO game_participants (game_id, user_id, roster_id, home_or_away, league_designation)
         VALUES ($1, $2, $3, $4, $5)`,
        [gameId, joiningUserId, roster_id, joiningPlayerHomeOrAway, joiningPlayerLeague]
      );
    
    // 3. Determine who bats first (the 'away' player) and update the game
    const awayPlayerId = joiningPlayerHomeOrAway === 'away' ? joiningUserId : hostPlayer.user_id;
    
    await client.query(
      `UPDATE games SET status = 'in_progress', current_turn_user_id = $1 WHERE game_id = $2`,
      [awayPlayerId, gameId]
    );
      
    await client.query('COMMIT');
    res.json({ message: 'Successfully joined game. The game is now in progress!' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Game join error:', error);
    res.status(500).json({ message: 'Server error while joining game.' });
  } finally {
    client.release();
  }
});

// PLAY A TURN (Protected Route)
app.post('/api/games/:gameId/play', authenticateToken, async (req, res) => {
    const { gameId } = req.params;
    const { action } = req.body; // For now, this will just be 'swing'
    const userId = req.user.userId;

    // --- Validation ---
    const client = await pool.connect();
    try {
        const gameQuery = await client.query('SELECT * FROM games WHERE game_id = $1', [gameId]);
        if (gameQuery.rows.length === 0) {
            return res.status(404).json({ message: 'Game not found.' });
        }
        const game = gameQuery.rows[0];

        if (game.status !== 'in_progress') {
            return res.status(400).json({ message: 'This game is not currently in progress.' });
        }
        if (game.current_turn_user_id !== userId) {
            return res.status(403).json({ message: "It's not your turn." });
        }
        
        // --- Game Logic ---
        // This is a simplified version for the MVP. We'll need to expand this.
        // For now, we'll just determine the batter and pitcher without worrying about lineups.
        const participants = await client.query('SELECT * FROM game_participants WHERE game_id = $1', [gameId]);
        const awayPlayer = participants.rows.find(p => p.home_or_away === 'away');
        const homePlayer = participants.rows.find(p => p.home_or_away === 'home');

        // Determine who is batting and who is pitching
        const offensivePlayer = (userId === awayPlayer.user_id) ? awayPlayer : homePlayer;
        const defensivePlayer = (userId === awayPlayer.user_id) ? homePlayer : awayPlayer;

        // Fetch a sample batter and pitcher from their rosters for this MVP test
        const batterQuery = await client.query('SELECT cp.* FROM roster_cards rc JOIN cards_player cp ON rc.card_id = cp.card_id WHERE rc.roster_id = $1 AND cp.on_base IS NOT NULL LIMIT 1', [offensivePlayer.roster_id]);
        const pitcherQuery = await client.query('SELECT cp.* FROM roster_cards rc JOIN cards_player cp ON rc.card_id = cp.card_id WHERE rc.roster_id = $1 AND cp.control IS NOT NULL LIMIT 1', [defensivePlayer.roster_id]);

        const batter = batterQuery.rows[0];
        const pitcher = pitcherQuery.rows[0];

        // 1. PITCH/ADVANTAGE ROLL
        const pitchRoll = Math.floor(Math.random() * 20) + 1;
        const advantageCheck = pitchRoll + pitcher.control;
        const hasAdvantage = advantageCheck >= batter.on_base ? 'pitcher' : 'batter';
        const advantageLog = `Pitch roll: ${pitchRoll} + ${pitcher.control} (CTL) = ${advantageCheck} vs ${batter.on_base} (OB). ${hasAdvantage.toUpperCase()} has the advantage.`;

        // 2. SWING/OUTCOME ROLL
        const swingRoll = Math.floor(Math.random() * 20) + 1;
        const chartHolder = hasAdvantage === 'pitcher' ? pitcher : batter;
        
        let outcome = 'OUT'; // Default outcome
        for (const range in chartHolder.chart_data) {
            const [min, max] = range.split('-').map(Number);
            if (swingRoll >= min && swingRoll <= max) {
                outcome = chartHolder.chart_data[range];
                break;
            }
        }
        const outcomeLog = `Swing roll: ${swingRoll}. Result on ${chartHolder.name}'s chart: ${outcome}!`;

        // --- State Update ---
        // For the MVP, we'll just log the event and pass the turn.
        // In the next phase, we'd update a full game state object (score, outs, runners).
        const fullLogMessage = `${batter.name} vs. ${pitcher.name}: ${advantageLog} ${outcomeLog}`;

        await client.query('BEGIN');

        // Insert into game_events
        await client.query(
            `INSERT INTO game_events (game_id, user_id, event_type, log_message) VALUES ($1, $2, $3, $4)`,
            [gameId, userId, 'at_bat', fullLogMessage]
        );

        // Pass the turn to the other player
        const nextTurnUserId = (userId === awayPlayer.user_id) ? homePlayer.user_id : awayPlayer.user_id;
        await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [nextTurnUserId, gameId]);

        await client.query('COMMIT');

        res.json({
            message: 'Turn successfully played.',
            log: fullLogMessage,
            outcome: outcome,
            nextTurn: nextTurnUserId
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Play turn error:', error);
        res.status(500).json({ message: 'Server error during turn.' });
    } finally {
        client.release();
    }
});