// server/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Importa o banco de palavras externo
const wordDatabase = require('./words');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"] 
    }
});

let games = {}; 

io.on('connection', (socket) => {
    console.log(`Nova conexão: ${socket.id}`);

    // 1. Entrar/Criar Sala
    socket.on('join_room', ({ roomId, playerName }) => {
        // --- FIX: Sai da sala anterior se houver (evita duplicidade) ---
        if (socket.data.roomId) {
            socket.leave(socket.data.roomId);
        }

        socket.join(roomId);
        
        // --- O SEGREDO: Salva a sala DENTRO do socket ---
        socket.data.roomId = roomId; 
        socket.data.playerName = playerName;

        // Se a sala não existe, cria
        if (!games[roomId]) {
            games[roomId] = {
                id: roomId,
                players: [],
                phase: 'LOBBY',
                wordPair: {},
                turnIndex: 0,
                winner: null,
                usedIndices: [],
                settings: {
                    mrWhiteCount: 1,
                    undercoverCount: 1
                },
                deleteTimer: null
            };
        }

        const game = games[roomId];

        // Cancela exclusão se a sala ia ser deletada
        if (game.deleteTimer) {
            console.log(`Sala ${roomId}: Exclusão cancelada (alguém entrou).`);
            clearTimeout(game.deleteTimer);
            game.deleteTimer = null;
        }

        // Verifica se o jogador já não está na lista (pra não duplicar nome se der F5)
        const existingPlayer = game.players.find(p => p.id === socket.id);
        if (!existingPlayer) {
            const newPlayer = {
                id: socket.id,
                name: playerName,
                role: null,
                word: null,
                isAlive: true,
                votes: 0,
                score: 0,
                description: ""
            };
            game.players.push(newPlayer);
        }

        io.to(roomId).emit('update_game', game);
    });

    socket.on('change_settings', ({ roomId, setting, change }) => {
        const game = games[roomId];
        if (!game || game.phase !== 'LOBBY') return;
        let newValue = game.settings[setting] + change;
        if (newValue < 0) newValue = 0;
        game.settings[setting] = newValue;
        io.to(roomId).emit('update_game', game);
    });

    socket.on('start_game', (roomId) => {
        const game = games[roomId];
        if (!game || game.players.length < 3 || game.phase !== 'LOBBY') return;

        const totalPlayers = game.players.length;
        let countMrWhite = game.settings.mrWhiteCount;
        let countUndercover = game.settings.undercoverCount;

        if ((countMrWhite + countUndercover) >= totalPlayers) {
            countMrWhite = 1;
            countUndercover = Math.max(0, Math.floor((totalPlayers - 2) / 2));
        }

        let roles = [];
        for (let i = 0; i < countMrWhite; i++) roles.push('mr_white');
        for (let i = 0; i < countUndercover; i++) roles.push('undercover');
        while (roles.length < totalPlayers) roles.push('civilian');

        roles.sort(() => Math.random() - 0.5);

        game.phase = 'DESCRIPTION';
        game.turnIndex = 0;
        game.winner = null;
        
        let availableIndices = [];
        for (let i = 0; i < wordDatabase.length; i++) {
            if (!game.usedIndices.includes(i)) availableIndices.push(i);
        }
        if (availableIndices.length === 0) {
            game.usedIndices = [];
            for (let i = 0; i < wordDatabase.length; i++) availableIndices.push(i);
        }

        const randomIndexPos = Math.floor(Math.random() * availableIndices.length);
        const selectedIndex = availableIndices[randomIndexPos];
        game.wordPair = wordDatabase[selectedIndex];
        game.usedIndices.push(selectedIndex);

        game.players.forEach((player, index) => {
            player.role = roles[index];
            player.isAlive = true;
            player.votes = 0;
            player.description = "";
            if (player.role === 'civilian') player.word = game.wordPair.civilian;
            else if (player.role === 'undercover') player.word = game.wordPair.undercover;
            else player.word = null;
        });

        game.players.sort(() => Math.random() - 0.5);
        while (game.players[0].role === 'mr_white') {
            const firstPlayer = game.players.shift();
            game.players.push(firstPlayer);
        }

        io.to(roomId).emit('update_game', game);
    });

    socket.on('send_description', ({ roomId, text }) => {
        const game = games[roomId];
        if (!game) return;
        const currentPlayer = game.players[game.turnIndex];
        if (currentPlayer.id === socket.id) {
            currentPlayer.description = text;
            let nextIndex = game.turnIndex + 1;
            while (nextIndex < game.players.length && !game.players[nextIndex].isAlive) nextIndex++;
            if (nextIndex >= game.players.length) game.phase = 'VOTING';
            else game.turnIndex = nextIndex;
            io.to(roomId).emit('update_game', game);
        }
    });

    socket.on('vote_player', ({ roomId, targetId }) => {
        const game = games[roomId];
        if (!game) return;
        const target = game.players.find(p => p.id === targetId);
        if (target) target.votes += 1;
        const totalVotes = game.players.reduce((acc, p) => acc + p.votes, 0);
        const aliveCount = game.players.filter(p => p.isAlive).length;
        if (totalVotes >= aliveCount) {
            const eliminated = game.players.reduce((prev, current) => (prev.votes > current.votes) ? prev : current);
            eliminated.isAlive = false;
            if (eliminated.role === 'mr_white') {
                game.phase = 'MR_WHITE_GUESS';
                io.to(roomId).emit('update_game', game);
                return;
            }
            checkWinCondition(game, roomId);
            if (game.phase !== 'GAME_OVER' && game.phase !== 'MR_WHITE_GUESS') {
                game.players.forEach(p => { p.votes = 0; p.description = ""; });
                game.phase = 'DESCRIPTION';
                game.turnIndex = 0;
                while (!game.players[game.turnIndex].isAlive) game.turnIndex++;
                io.to(roomId).emit('update_game', game);
            }
        } else {
            io.to(roomId).emit('update_game', game);
        }
    });

    socket.on('mr_white_guess', ({ roomId, guess }) => {
        const game = games[roomId];
        if (!game) return;
        const correctWord = game.wordPair.civilian.toLowerCase();
        if (guess.toLowerCase().trim() === correctWord) endGame(game, 'MR_WHITE_WINS');
        else checkWinCondition(game, roomId);
        io.to(roomId).emit('update_game', game);
    });

    // --- NOVA LÓGICA DE DESCONEXÃO (DIRETA E RÁPIDA) ---
    socket.on('disconnect', () => {
        console.log(`Desconectado: ${socket.id}`);
        
        // Recupera a sala direto do "crachá" do socket
        const roomId = socket.data.roomId; 

        if (roomId && games[roomId]) {
            const game = games[roomId];
            
            // Remove o jogador
            game.players = game.players.filter(p => p.id !== socket.id);
            
            // Avisa a sala IMEDIATAMENTE
            io.to(roomId).emit('update_game', game);
            
            console.log(`Jogador removido da sala ${roomId}. Restam: ${game.players.length}`);

            // Verifica se esvaziou
            if (game.players.length === 0) {
                console.log(`Sala ${roomId} vazia. Excluindo em 5 minutos...`);
                game.deleteTimer = setTimeout(() => {
                    console.log(`Sala ${roomId} expirou e foi excluída.`);
                    delete games[roomId];
                }, 5 * 60 * 1000);
            }
        }
    });
});

function checkWinCondition(game, roomId) {
    const civiliansAlive = game.players.filter(p => p.role === 'civilian' && p.isAlive).length;
    const impostorsAlive = game.players.filter(p => (p.role === 'undercover' || p.role === 'mr_white') && p.isAlive).length;
    if (impostorsAlive === 0) endGame(game, 'CIVILIANS_WIN');
    else if (impostorsAlive >= civiliansAlive) endGame(game, 'IMPOSTORS_WIN');
}

function endGame(game, result) {
    game.phase = 'GAME_OVER';
    game.winner = result;
    game.players.forEach(p => {
        if (result === 'CIVILIANS_WIN' && p.role === 'civilian') p.score += 2;
        if (result === 'MR_WHITE_WINS' && p.role === 'mr_white') p.score += 6;
        if (result === 'IMPOSTORS_WIN') {
            if (p.role === 'undercover') p.score += 10;
            if (p.role === 'mr_white') p.score += 10;
        }
    });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`SERVIDOR RODANDO NA PORTA ${PORT}`);
});
