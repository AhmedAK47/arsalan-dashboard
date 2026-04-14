# Google Sheet JSON API + Dashboard Integration

## Run the API server

1. Open terminal in this folder.
2. Run:

npm start

Server will run on:

http://localhost:3000

## API endpoint

Default endpoint using your sheet:

http://localhost:3000/api/sheet

Optional params:

- sheet: full Google Sheet URL or sheet ID
- gid: worksheet ID

Examples:

http://localhost:3000/api/sheet?gid=0
http://localhost:3000/api/sheet?sheet=18ATEk4-2YihvjwxHRAaQNpVsOEaNP3a_S1QoPvT3fVQ

## HTML integration

The file index (5).html is already integrated with the API using vanilla JavaScript.

- It calls http://localhost:3000/api/sheet on page load.
- It fills the Workforce Roster table from the returned rows.
- If API is unavailable, it keeps the built-in sample data.

## Important

For Google Sheets to work, the sheet must be accessible to anyone with the link (Viewer).
