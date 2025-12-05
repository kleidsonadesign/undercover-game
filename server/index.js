// server/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Importa o banco de palavras externo (certifique-se que o arquivo words.js existe na mesma pasta)
const wordDatabase = require('./words');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { 
        origin: "*", // Permite conexão de qualquer frontend (Vercel/Localhost)
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
                phase: 'LOBBY', // LOBBY, DESCRIPTION, VOTING, MR_WHITE_GUESS, GAME_OVER
                wordPair: {},
                turnIndex: 0,
                winner: null,
                usedIndices: [] // Histórico para não repetir palavras
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

    // 2. Iniciar Jogo
    socket.on('start_game', (roomId) => {
        const game = games[roomId];
        if (!game || game.players.length < 3) return; // Mínimo 3 jogadores

        // Resetar estado da rodada
        game.phase = 'DESCRIPTION';
        game.turnIndex = 0;
        game.winner = null;
        
        // --- LÓGICA DE NÃO REPETIR PALAVRAS ---
        
        // A. Descobrir quais índices ainda não foram usados nesta sala
        let availableIndices = [];
        for (let i = 0; i < wordDatabase.length; i++) {
            if (!game.usedIndices.includes(i)) {
                availableIndices.push(i);
            }
        }

        // B. Se acabaram as palavras, reseta o histórico (Loop infinito de diversão)
        if (availableIndices.length === 0) {
            console.log(`Sala ${roomId}: Palavras acabaram. Resetando histórico.`);
            game.usedIndices = [];
            // Recarrega todos os índices
            for (let i = 0; i < wordDatabase.length; i++) availableIndices.push(i);
        }

        // C. Sorteia apenas entre os disponíveis
        const randomIndexPos = Math.floor(Math.random() * availableIndices.length);
        const selectedIndex = availableIndices[randomIndexPos];

        // D. Salva a escolha e marca como usada
        game.wordPair = wordDatabase[selectedIndex];
        game.usedIndices.push(selectedIndex);

        // --------------------------------------

        // Definir quantidades de papéis
        const total = game.players.length;
        let roles = ['mr_white']; // Sempre 1 Mr. White
        // Calcula Undercovers: aprox 1 para cada 3 ou 4 jogadores
        let undercoversCount = Math.max(1, Math.floor((total - 1) / 3)); 
        
        for (let i = 0; i < undercoversCount; i++) roles.push('undercover');
        while (roles.length < total) roles.push('civilian');

        // Embaralhar papéis (Fisher-Yates shuffle simplificado)
        roles.sort(() => Math.random() - 0.5);

        // Atribuir aos jogadores
        game.players.forEach((player, index) => {
            player.role = roles[index];
            player.isAlive = true;
            player.votes = 0;
            player.description = "";
            
            if (player.role === 'civilian') player.word = game.wordPair.civilian;
            else if (player.role === 'undercover') player.word = game.wordPair.undercover;
            else player.word = null; // Mr. White não tem palavra
        });

        // Embaralhar ordem de turno para descrições
        game.players.sort(() => Math.random() - 0.5);

        io.to(roomId).emit('update_game', game);
    });

    // 3. Enviar Descrição
    socket.on('send_description', ({ roomId, text }) => {
        const game = games[roomId];
        if (!game) return;

        const currentPlayer = game.players[game.turnIndex];
        
        // Validação extra para garantir que é a vez de quem enviou
        if (currentPlayer.id === socket.id) {
            currentPlayer.description = text;
            
            // Passa para o próximo jogador vivo
            let nextIndex = game.turnIndex + 1;
            while (nextIndex < game.players.length && !game.players[nextIndex].isAlive) {
                nextIndex++;
            }

            // Se acabou a lista, vai para votação
            if (nextIndex >= game.players.length) {
                game.phase = 'VOTING';
            } else {
                game.turnIndex = nextIndex;
            }
            io.to(roomId).emit('update_game', game);
        }
    });

    // 4. Votar para eliminar
    socket.on('vote_player', ({ roomId, targetId }) => {
        const game = games[roomId];
        if (!game) return;

        const target = game.players.find(p => p.id === targetId);
        if (target) target.votes += 1;

        // Verifica se todos os vivos votaram
        const totalVotes = game.players.reduce((acc, p) => acc + p.votes, 0);
        const aliveCount = game.players.filter(p => p.isAlive).length;

        if (totalVotes >= aliveCount) {
            // Eliminar quem tem mais votos
            const eliminated = game.players.reduce((prev, current) => 
                (prev.votes > current.votes) ? prev : current
            );

            eliminated.isAlive = false;

            // REGRA ESPECIAL: Se Mr. White morre, ele tem chance de adivinhar
            if (eliminated.role === 'mr_white') {
                game.phase = 'MR_WHITE_GUESS';
                io.to(roomId).emit('update_game', game);
                return;
            }

            checkWinCondition(game, roomId);
            
            // Se ninguém ganhou, prepara nova rodada de descrições
            if (game.phase !== 'GAME_OVER' && game.phase !== 'MR_WHITE_GUESS') {
                // Reseta votos e descrições
                game.players.forEach(p => { p.votes = 0; p.description = ""; });
                game.phase = 'DESCRIPTION';
                
                // Reinicia turnos (apenas vivos)
                game.turnIndex = 0;
                while (!game.players[game.turnIndex].isAlive) game.turnIndex++;
                
                io.to(roomId).emit('update_game', game);
            }
        } else {
            // Apenas atualiza votos na tela
            io.to(roomId).emit('update_game', game);
        }
    });

    // 5. Mr. White tenta adivinhar
    socket.on('mr_white_guess', ({ roomId, guess }) => {
        const game = games[roomId];
        if (!game) return;

        const correctWord = game.wordPair.civilian.toLowerCase();
        // Remove acentos e espaços para facilitar comparação
        const normalizedGuess = guess.toLowerCase().trim(); 

        if (normalizedGuess === correctWord) {
            endGame(game, 'MR_WHITE_WINS');
        } else {
            checkWinCondition(game, roomId); // Errou e morreu definitivamente
        }
        io.to(roomId).emit('update_game', game);
    });

    socket.on('disconnect', () => {
        // Futuramente: implementar reconexão
        console.log(`Jogador desconectado: ${socket.id}`);
    });
});

function checkWinCondition(game, roomId) {
    const civiliansAlive = game.players.filter(p => p.role === 'civilian' && p.isAlive).length;
    // Impostores = Undercover + Mr. White
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
    
    // Sistema de Pontuação Acumulativa
    game.players.forEach(p => {
        if (result === 'CIVILIANS_WIN' && p.role === 'civilian') p.score += 2;
        if (result === 'MR_WHITE_WINS' && p.role === 'mr_white') p.score += 6;
        if (result === 'IMPOSTORS_WIN') {
            if (p.role === 'undercover') p.score += 10;
            if (p.role === 'mr_white') p.score += 10;
        }
    });
}

// Porta dinâmica para deploy (Render/Heroku) ou 3001 local
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`SERVIDOR RODANDO NA PORTA ${PORT}`);
});