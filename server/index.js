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
        origin: "*", // Permite conexões de qualquer lugar (Vercel/Localhost)
        methods: ["GET", "POST"] 
    }
});

// Armazena o estado de todas as salas
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
                usedIndices: [], // Histórico de palavras
                // Configurações Padrão (1 Mr White, 1 Undercover)
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

    // 2. Alterar Configurações (Botões + e - no Lobby)
    socket.on('change_settings', ({ roomId, setting, change }) => {
        const game = games[roomId];
        if (!game || game.phase !== 'LOBBY') return;

        let newValue = game.settings[setting] + change;
        if (newValue < 0) newValue = 0; // Não pode ser negativo

        game.settings[setting] = newValue;
        io.to(roomId).emit('update_game', game);
    });

    // 3. Iniciar Jogo
    socket.on('start_game', (roomId) => {
        const game = games[roomId];
        // Trava de segurança: só inicia se estiver no Lobby e tiver gente suficiente
        if (!game || game.players.length < 3 || game.phase !== 'LOBBY') return;

        // --- DEFINIÇÃO DE PAPÉIS (BASEADO NA CONFIGURAÇÃO) ---
        const totalPlayers = game.players.length;
        let countMrWhite = game.settings.mrWhiteCount;
        let countUndercover = game.settings.undercoverCount;

        // Validação de Segurança: Se a soma de inimigos for >= total de jogadores, reseta.
        if ((countMrWhite + countUndercover) >= totalPlayers) {
            countMrWhite = 1;
            countUndercover = Math.max(0, Math.floor((totalPlayers - 2) / 2));
        }

        let roles = [];
        for (let i = 0; i < countMrWhite; i++) roles.push('mr_white');
        for (let i = 0; i < countUndercover; i++) roles.push('undercover');
        while (roles.length < totalPlayers) roles.push('civilian');

        // Embaralha os papéis
        roles.sort(() => Math.random() - 0.5);
        // -----------------------------------------------------

        // Configura a fase inicial
        game.phase = 'DESCRIPTION';
        game.turnIndex = 0;
        game.winner = null;
        
        // --- SORTEIO DE PALAVRAS (SEM REPETIÇÃO) ---
        let availableIndices = [];
        for (let i = 0; i < wordDatabase.length; i++) {
            if (!game.usedIndices.includes(i)) availableIndices.push(i);
        }
        
        // Se acabaram as palavras, reseta o histórico
        if (availableIndices.length === 0) {
            game.usedIndices = [];
            for (let i = 0; i < wordDatabase.length; i++) availableIndices.push(i);
        }

        const randomIndexPos = Math.floor(Math.random() * availableIndices.length);
        const selectedIndex = availableIndices[randomIndexPos];
        game.wordPair = wordDatabase[selectedIndex];
        game.usedIndices.push(selectedIndex);
        // -------------------------------------------

        // Atribui papéis e palavras aos jogadores
        game.players.forEach((player, index) => {
            player.role = roles[index];
            player.isAlive = true;
            player.votes = 0;
            player.description = "";
            
            if (player.role === 'civilian') player.word = game.wordPair.civilian;
            else if (player.role === 'undercover') player.word = game.wordPair.undercover;
            else player.word = null; // Mr. White não vê nada
        });

        // --- DEFINIR ORDEM DE TURNOS ---
        
        // 1. Embaralha aleatoriamente
        game.players.sort(() => Math.random() - 0.5);

        // 2. REGRA DE OURO: Mr. White NÃO pode ser o primeiro
        // Se o primeiro sorteado for Mr. White, joga ele pro final da fila
        // O while garante que se tiver 2 Mr. Whites, ele joga ambos pro final até achar um civil/undercover
        while (game.players[0].role === 'mr_white') {
            const firstPlayer = game.players.shift(); // Remove o primeiro
            game.players.push(firstPlayer);           // Adiciona no final
        }

        io.to(roomId).emit('update_game', game);
    });

    // 4. Receber Descrição
    socket.on('send_description', ({ roomId, text }) => {
        const game = games[roomId];
        if (!game) return;

        const currentPlayer = game.players[game.turnIndex];
        
        // Só aceita se for a vez de quem enviou
        if (currentPlayer.id === socket.id) {
            currentPlayer.description = text;
            
            // Passa para o próximo vivo
            let nextIndex = game.turnIndex + 1;
            while (nextIndex < game.players.length && !game.players[nextIndex].isAlive) {
                nextIndex++;
            }

            if (nextIndex >= game.players.length) {
                game.phase = 'VOTING'; // Todos falaram
            } else {
                game.turnIndex = nextIndex;
            }
            io.to(roomId).emit('update_game', game);
        }
    });

    // 5. Votação
    socket.on('vote_player', ({ roomId, targetId }) => {
        const game = games[roomId];
        if (!game) return;

        const target = game.players.find(p => p.id === targetId);
        if (target) target.votes += 1;

        // Verifica total de votos vs jogadores vivos
        const totalVotes = game.players.reduce((acc, p) => acc + p.votes, 0);
        const aliveCount = game.players.filter(p => p.isAlive).length;

        if (totalVotes >= aliveCount) {
            // Elimina o mais votado
            const eliminated = game.players.reduce((prev, current) => 
                (prev.votes > current.votes) ? prev : current
            );

            eliminated.isAlive = false;

            // Se for Mr. White, dá a chance de adivinhar
            if (eliminated.role === 'mr_white') {
                game.phase = 'MR_WHITE_GUESS';
                io.to(roomId).emit('update_game', game);
                return;
            }

            checkWinCondition(game, roomId);
            
            // Se o jogo continua, prepara nova rodada
            if (game.phase !== 'GAME_OVER' && game.phase !== 'MR_WHITE_GUESS') {
                game.players.forEach(p => { p.votes = 0; p.description = ""; });
                game.phase = 'DESCRIPTION';
                
                // Reinicia turnos (apenas vivos) e garante que Mr White (se houver outro) não inicie
                // (Opcional: re-embaralhar ou manter ordem. Aqui mantemos a ordem original dos vivos)
                game.turnIndex = 0;
                while (!game.players[game.turnIndex].isAlive) game.turnIndex++;
                
                io.to(roomId).emit('update_game', game);
            }
        } else {
            io.to(roomId).emit('update_game', game);
        }
    });

    // 6. Mr. White Adivinha
    socket.on('mr_white_guess', ({ roomId, guess }) => {
        const game = games[roomId];
        if (!game) return;

        const correctWord = game.wordPair.civilian.toLowerCase();
        const cleanGuess = guess.toLowerCase().trim();

        if (cleanGuess === correctWord) {
            endGame(game, 'MR_WHITE_WINS');
        } else {
            checkWinCondition(game, roomId);
        }
        io.to(roomId).emit('update_game', game);
    });
});

function checkWinCondition(game, roomId) {
    const civiliansAlive = game.players.filter(p => p.role === 'civilian' && p.isAlive).length;
    const impostorsAlive = game.players.filter(p => (p.role === 'undercover' || p.role === 'mr_white') && p.isAlive).length;

    if (impostorsAlive === 0) {
        endGame(game, 'CIVILIANS_WIN');
    } else if (impostorsAlive >= civiliansAlive) {
        endGame(game, 'IMPOSTORS_WIN');
    }
}

function endGame(game, result) {
    game.phase = 'GAME_OVER';
    game.winner = result;
    
    // Pontuação
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
