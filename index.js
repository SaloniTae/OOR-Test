const express = require('express');
const app = express();

// Use the PORT environment variable provided by Render, or default to 3000 locally
const PORT = process.env.PORT || 3000;

// A simple home route to verify the app is running
app.get('/', (req, res) => {
    res.send('Server is up and running. Go to /test-netflix to run the test.');
});

// Your Netflix test route
app.get('/test-netflix', async (req, res) => {
    try {
        const response = await fetch('https://www.netflix.com', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            }
        });
        
        const text = await response.text();
        
        res.json({
            status: response.status,
            ok: response.ok,
            isBlocked: text.includes('captcha') || text.includes('Access Denied')
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
