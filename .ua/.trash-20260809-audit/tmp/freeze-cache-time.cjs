// Keep diagnostics deterministic and offline by treating the newest cached candle as current.
Date.now = () => 1785934800000;
