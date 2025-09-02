const express = require('express');
const router = express.Router();
const { pool, io } = require('../server');
const authenticateToken = require('../middleware/authenticateToken');

router.post('/games/:gameId/set-state', authenticateToken, async (req, res) => {
    const { gameId } = req.params;
    const partialState = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const stateResult = await client.query('SELECT * FROM game_states WHERE game_id = $1 ORDER BY turn_number DESC LIMIT 1', [gameId]);
        
        if (stateResult.rows.length === 0) {
            return res.status(404).json({ message: 'Game state not found.' });
        }

        const currentState = stateResult.rows[0].state_data;
        const currentTurn = stateResult.rows[0].turn_number;

        // Merge the partial state from the request into the current state
        // A smarter merge that handles nested objects
        const newState = { ...currentState };
        for (const key in partialState) {
            if (typeof partialState[key] === 'object' && partialState[key] !== null && !Array.isArray(partialState[key])) {
                newState[key] = { ...newState[key], ...partialState[key] };
            } else {
                newState[key] = partialState[key];
            }
        }
        // Also update the main game table's turn info if provided
        if (partialState.current_turn_user_id) {
            await client.query('UPDATE games SET current_turn_user_id = $1 WHERE game_id = $2', [partialState.current_turn_user_id, gameId]);
        }

        await client.query('INSERT INTO game_states (game_id, turn_number, state_data) VALUES ($1, $2, $3)', [gameId, currentTurn + 1, newState]);
        
        await client.query('COMMIT');
        io.to(gameId).emit('game-updated'); // Notify clients of the change
        res.status(200).json({ message: 'Game state updated successfully.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error setting dev state:', error);
        res.status(500).json({ message: 'Server error while setting state.' });
    } finally {
        client.release();
    }
});

module.exports = router;
