# Google Sheet JSON API + Dashboard Integration

## Setup

1. Install dependencies:

npm install

2. Create a .env file with your Google service account credentials:

PORT=3000
GOOGLE_SHEET_ID=18ATEk4-2YihvjwxHRAaQNpVsOEaNP3a_S1QoPvT3fVQ
GOOGLE_SHEET_NAME=Overview Page
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY\n-----END PRIVATE KEY-----\n"

3. Share the Google Sheet with the service account email as a Viewer.

## Run the API server

npm start

The API runs on:

http://localhost:3000

## API endpoint

Default endpoint:

http://localhost:3000/api/sheet

Optional params:

- sheet: full Google Sheet URL or spreadsheet ID
- sheetName: worksheet name, defaults to Overview Page

Example:

http://localhost:3000/api/sheet?sheetName=Overview%20Page

## Response format

The API returns structured JSON using the first row as headers, converts empty cells to null, and ignores fully empty rows.
