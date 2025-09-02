import os
import psycopg2
from dotenv import load_dotenv

# Load database credentials from your .env file
load_dotenv()

# --- The formulas you discovered ---
BASE_SET_OFFSET = 692  # So that card #1 maps to image ID 693
PENNANT_RUN_OFFSET = 1229 # So that card #1 maps to image ID 1230

def get_db_connection():
    """Establishes a connection to the PostgreSQL database."""
    conn = psycopg2.connect(
        dbname=os.getenv('DB_DATABASE'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASSWORD'),
        host=os.getenv('DB_HOST'),
        port=os.getenv('DB_PORT')
    )
    return conn

def main():
    """Generates and updates image URLs for all cards in the database."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # Get all players
        cur.execute("SELECT card_id, set_name, card_number FROM cards_player")
        players = cur.fetchall()

        print(f"Found {len(players)} players. Generating image URLs...")
        update_count = 0

        for player in players:
            card_id, set_name, card_number = player
            image_id = 0

            if set_name == 'Base':
                image_id = BASE_SET_OFFSET + card_number
            elif set_name == 'PR':
                image_id = PENNANT_RUN_OFFSET + card_number
            
            if image_id > 0:
                image_url = f"https://showdowncards.com/images/product/{image_id}.jpg"
                
                # Update the database with the new URL
                cur.execute(
                    "UPDATE cards_player SET image_url = %s WHERE card_id = %s",
                    (image_url, card_id)
                )
                update_count += 1

        conn.commit()
        print(f"\nSuccessfully generated and saved URLs for {update_count} cards.")
        print("Image data is now complete!")

    except (Exception, psycopg2.DatabaseError) as error:
        print(f"An error occurred: {error}")
    finally:
        if conn is not None:
            cur.close()
            conn.close()

if __name__ == "__main__":
    main()
