import os
import time
import requests
import psycopg2
from dotenv import load_dotenv

# Load database credentials from your .env file
load_dotenv()

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
    """Validates existing image_urls and corrects them if they are broken."""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # Get all players that have an image_url to check
        cur.execute("SELECT card_id, name, image_url FROM cards_player WHERE image_url IS NOT NULL ORDER BY card_id")
        players_to_check = cur.fetchall()

        print(f"Found {len(players_to_check)} players with image URLs to validate. Starting check...")
        fixed_count = 0
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/115.0'
        }

        for i, player in enumerate(players_to_check):
            card_id, player_name, original_url = player
            print(f"({i+1}/{len(players_to_check)}) Checking {player_name}...", end='', flush=True)

            try:
                # Use a HEAD request to be faster and use less data
                response = requests.head(original_url, headers=headers, allow_redirects=True, timeout=10)

                # Check if the final URL is the error page
                if "DefaultError404" in response.url:
                    print(f" -> Failed. Trying alternate URL...", end='', flush=True)
                    
                    # Construct the alternate URL
                    alternate_url = original_url.replace("/Large/", "/Cards/")
                    
                    alt_response = requests.head(alternate_url, headers=headers, allow_redirects=True, timeout=10)
                    
                    if alt_response.status_code == 200 and "DefaultError404" not in alt_response.url:
                        # Success! Update the database
                        cur.execute(
                            "UPDATE cards_player SET image_url = %s WHERE card_id = %s",
                            (alternate_url, card_id)
                        )
                        conn.commit()
                        print(f" ✓ Fixed!")
                        fixed_count += 1
                    else:
                        print(f" ✗ Alternate also failed.")
                else:
                    print(" ✓ OK.")

            except requests.exceptions.RequestException as e:
                print(f" ✗ Network Error: {e}")

            time.sleep(0.2) # Be respectful to the server

        print(f"\nValidation complete. Fixed {fixed_count} broken URLs.")

    except (Exception, psycopg2.DatabaseError) as error:
        print(f"An error occurred: {error}")
    finally:
        if conn is not None:
            cur.close()
            conn.close()

if __name__ == "__main__":
    main()
