// server/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const wordDatabase = require('./words');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let games = {}; 

io.on('connection', (socket) => {
    console.log(`Jogador conectado: ${socket.id}`);

    // 1. Entrar/Criar Sala
    socket.on('join_room', ({ roomId, playerName }) => {
        socket.join(roomId);

        if (!games[roomId]) {
            games[roomId] = {
                id: roomId,
                players: [],
                phase: 'LOBBY',
                wordPair: {},
                turnIndex: 0,
                winner: null,
                usedIndices: [],
                // NOVO: Configurações padrão da sala
                settings: {
                    mrWhiteCount: 1,
                    undercoverCount: 1
                }
            };
        }

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

        games[roomId].players.push(newPlayer);
        io.to(roomId).emit('update_game', games[roomId]);
    });

    // NOVO: Evento para alterar configurações
    socket.on('change_settings', ({ roomId, setting, change }) => {
        const game = games[roomId];
        if (!game || game.phase !== 'LOBBY') return;

        // Atualiza o valor (com limites de segurança)
        let newValue = game.settings[setting] + change;
        
        // Regras de limite:
        // 1. Não pode ser negativo
        if (newValue < 0) newValue = 0;
        
        // 2. Segurança básica: Total de inimigos não pode ser maior que (Jogadores - 1)
        // Isso é só uma pré-validação, a real acontece no start_game
        game.settings[setting] = newValue;

        // Avisa todo mundo da mudança
        io.to(roomId).emit('update_game', game);
    });

    // 2. Iniciar Jogo (Lógica Atualizada)
    socket.on('start_game', (roomId) => {
        const game = games[roomId];
        if (!game || game.players.length < 3 || game.phase !== 'LOBBY') return;

        // --- LÓGICA DE PAPÉIS CONFIGURÁVEL ---
        const totalPlayers = game.players.length;
        
        // Recupera o que os jogadores escolheram
        let countMrWhite = game.settings.mrWhiteCount;
        let countUndercover = game.settings.undercoverCount;

        // VALIDAÇÃO FINAL DE SEGURANÇA:
        // Se a soma de inimigos for maior ou igual ao número de jogadores, forçamos o ajuste.
        // Pelo menos 1 civil deve existir.
        if ((countMrWhite + countUndercover) >= totalPlayers) {
            // Reseta para padrão seguro se a configuração for impossível
            countMrWhite = 1;
            countUndercover = Math.max(0, Math.floor((totalPlayers - 2) / 2));
        }

        let roles = [];
        for (let i = 0; i < countMrWhite; i++) roles.push('mr_white');
        for (let i = 0; i < countUndercover; i++) roles.push('undercover');
        
        // O resto vira Civil
        while (roles.length < totalPlayers) roles.push('civilian');

        // Embaralhar papéis
        roles.sort(() => Math.random() - 0.5);
        // --------------------------------------

        // Resetar estado da rodada
        game.phase = 'DESCRIPTION';
        game.turnIndex = 0;
        game.winner = null;
        
        // Sorteio de palavras (com histórico)
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

        // Atribuir aos jogadores
        game.players.forEach((player, index) => {
            player.role = roles[index];
            player.isAlive = true;
            player.votes = 0;
            player.description = "";
            
            if (player.role === 'civilian') player.word = game.wordPair.civilian;
            else if (player.role === 'undercover') player.word = game.wordPair.undercover;
            else player.word = null;
        });

        // Ordem de turno aleatória
        game.players.sort(() => Math.random() - 0.5);

        io.to(roomId).emit('update_game', game);
    });

    // ... (Eventos send_description, vote_player, mr_white_guess continuam iguais ao anterior) ...
    // Vou omitir aqui para economizar espaço, mas mantenha o resto do código igual!
    
    // --- MANTENHA O RESTO DO CÓDIGO (send_description até o fim) IGUAL ---
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
server.listen(PORT, () => { console.log(`SERVIDOR RODANDO NA PORTA ${PORT}`); });
