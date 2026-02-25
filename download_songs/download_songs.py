import os
import subprocess

# הגדרות
LINKS_FILE = "links.txt"
OUTPUT_DIR = "songs"

def download_songs():
    # יצירת התיקייה לשירים אם היא לא קיימת
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        print(f"📁 Created directory: {OUTPUT_DIR}/")

    # בדיקה שקובץ הקישורים קיים
    if not os.path.isfile(LINKS_FILE):
        print(f"❌ Error: Could not find '{LINKS_FILE}'. Please create it and add YouTube links.")
        return

    # קריאת הקישורים מהקובץ (התעלמות משורות ריקות)
    with open(LINKS_FILE, "r") as file:
        links = [line.strip() for line in file if line.strip()]

    if not links:
        print(f"⚠️ No links found in {LINKS_FILE}.")
        return

    print(f"🎵 Found {len(links)} links. Starting downloads...\n")

    # מעבר על כל קישור והורדה
    for index, link in enumerate(links, start=1):
        print(f"--- Downloading {index}/{len(links)} ---")
        
        # הרכבת פקודת הטרמינל
        command = [
            "yt-dlp",
            "-x",                                     # חילוץ אודיו בלבד
            "--audio-format", "mp3",                  # המרה לפורמט MP3
            "-o", f"{OUTPUT_DIR}/%(title)s.%(ext)s",  # שמירה בתיקייה עם שם הסרטון המקורי
            link
        ]
        
        try:
            # הרצת הפקודה והמתנה לסיומה
            subprocess.run(command, check=True)
        except subprocess.CalledProcessError:
            print(f"❌ Failed to download: {link}")
            
    print("\n✅ All downloads finished!")

if __name__ == "__main__":
    download_songs()