// Fixed numbers and environment options. Admin-editable game numbers live in settings.js.
// Coins are virtual. Nothing here touches real money (see src/payments.js).
module.exports = {
  BRAND: 'BetDouble',
  COIN: 'BDC',
  // Coins given to each new account so they can try the game.
  SIGNUP_BONUS: 100,
  // Demo deposits: an "Add coins" button that gives free virtual coins. Turn off once a
  // licensed payment provider is plugged in (see src/payments.js).
  DEMO_DEPOSITS: process.env.DEMO_DEPOSITS !== 'false',
  PORT: Number(process.env.PORT || 3000),
  DB_PATH: process.env.DB_PATH || 'data.sqlite',
  // Set CRASH_AUTOSTART=false to stop the round loop (used by tests).
  CRASH_AUTOSTART: process.env.CRASH_AUTOSTART !== 'false',
};
