// ingest-data.js - DEFINITIVE FINAL VERSION
require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parser');
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: false
});

function createChartData(row, isPitcher = false) {
    const chart = {};
    let currentRoll = 1;
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

async function processCsv(filePath) {
  return new Promise((resolve, reject) => {
    const records = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => records.push(row))
      .on('end', () => resolve(records))
      .on('error', reject);
  });
}

async function ingestData() {
  console.log('Starting data ingestion process...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Clearing existing card data...');
    await client.query('TRUNCATE TABLE cards_player RESTART IDENTITY CASCADE');
    
    const hitters = await processCsv('hitters.csv');
    const pitchers = await processCsv('pitchers.csv');
    const allPlayersRaw = [...hitters, ...pitchers];
    const uniquePlayers = new Map();

    for (const playerRow of allPlayersRaw) {
      const name = `${playerRow.First} ${playerRow.Last}`;
      const key = `${name}|${playerRow.Set}|${playerRow.Num}`;

      if (uniquePlayers.has(key)) {
        const existingPlayer = uniquePlayers.get(key);
        if (playerRow.Pos && playerRow.Fld) {
            existingPlayer.positions.push({ pos: playerRow.Pos, fld: playerRow.Fld });
        }
      } else {
        playerRow.positions = [];
        if (playerRow.Pos && playerRow.Fld) {
            playerRow.positions.push({ pos: playerRow.Pos, fld: playerRow.Fld });
        }
        uniquePlayers.set(key, playerRow);
      }
    }
    
    console.log(`Read ${allPlayersRaw.length} rows, de-duplicated to ${uniquePlayers.size} unique player cards.`);
    console.log('Inserting cards into database...');

    for (const row of uniquePlayers.values()) {
      const isPitcher = !!row.Ctl;
      const fielding_ratings = {};
      if (!isPitcher) {
          row.positions.forEach(p => {
              fielding_ratings[p.pos] = parseInt(p.fld, 10);
          });
      }

      const card = {
        name: `${row.First} ${row.Last}`,
        team: row.Tm,
        year: 2001,
        points: parseInt(row.Pts, 10) || null,
        on_base: isPitcher ? null : parseInt(row.OB, 10) || null,
        control: isPitcher ? (parseInt(row.Ctl, 10) || 0) : null,
        ip: isPitcher ? parseInt(row.IP, 10) || null : null,
        speed: isPitcher ? null : row.Spd,
        fielding_ratings: isPitcher ? null : fielding_ratings,
        chart_data: createChartData(row, isPitcher),
      };
      
      const insertQuery = `INSERT INTO cards_player (name, team, year, points, on_base, control, ip, speed, fielding_ratings, chart_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
      const values = [card.name, card.team, card.year, card.points, card.on_base, card.control, card.ip, card.speed, card.fielding_ratings, card.chart_data];
      await client.query(insertQuery, values);
    }

    await client.query('COMMIT');
    console.log('✅ Data ingestion complete!');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Data ingestion failed:', e);
  } finally {
    client.release();
    await pool.end();
  }
}

ingestData();