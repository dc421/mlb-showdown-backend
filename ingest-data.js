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