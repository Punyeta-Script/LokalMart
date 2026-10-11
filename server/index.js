// Local development entry point: `npm start` -> http://localhost:3000
// (On Vercel the app is served through api/index.js instead.)
const app = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LokalMart running on http://localhost:${PORT}`));
