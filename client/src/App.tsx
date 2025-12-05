// client/src/App.tsx
import { useState, useEffect } from 'react';
import io, { Socket } from 'socket.io-client';
import './App.css';

// --- TIPOS (INTERFACES) ---
interface Player {
  id: string;
  name: string;
  role: 'civilian' | 'undercover' | 'mr_white' | null;
  word: string | null;
  isAlive: boolean;
  votes: number;
  score: number;
  description: string;
}

interface WordPair {
  civilian: string;
  undercover: string;
}

interface GameState {
  id: string;
  players: Player[];
  phase: 'LOBBY' | 'DESCRIPTION' | 'VOTING' | 'MR_WHITE_GUESS' | 'GAME_OVER';
  wordPair: WordPair;
  turnIndex: number;
  winner: string | null;
  // Configurações da sala
  settings: {
    mrWhiteCount: number;
    undercoverCount: number;
  }
}

// URL da API (Render em produção ou Localhost em desenvolvimento)
const SOCKET_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const socket: Socket = io(SOCKET_URL);

function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [roomId, setRoomId] = useState<string>('');
  const [playerName, setPlayerName] = useState<string>('');
  const [joined, setJoined] = useState<boolean>(false);
  const [descriptionInput, setDescriptionInput] = useState<string>('');
  const [mrWhiteGuess, setMrWhiteGuess] = useState<string>('');

  useEffect(() => {
    socket.on('update_game', (game: GameState) => setGameState(game));
    return () => { socket.off('update_game'); };
  }, []);

  const joinRoom = () => {
    if (roomId && playerName) {
      socket.emit('join_room', { roomId, playerName });
      setJoined(true);
    }
  };

  const startGame = () => socket.emit('start_game', roomId);
  
  // Função para os botões + e - do Lobby
  const changeSettings = (setting: 'mrWhiteCount' | 'undercoverCount', change: number) => {
    socket.emit('change_settings', { roomId, setting, change });
  };

  const sendDescription = () => {
    if(descriptionInput.trim()) {
      socket.emit('send_description', { roomId, text: descriptionInput });
      setDescriptionInput('');
    }
  };

  const votePlayer = (targetId: string) => socket.emit('vote_player', { roomId, targetId });
  const sendMrWhiteGuess = () => socket.emit('mr_white_guess', { roomId, guess: mrWhiteGuess });

  // --- COMPONENTE DE REGRAS (Para não repetir código) ---
  const RulesBox = () => (
    <div className="rules-box">
      <h3>📜 REGRAS (Passe o mouse)</h3>
      <ul className="rules-list">
        <li><strong>1.</strong> Cada jogador recebe uma palavra; todos iguais menos o <em>Espião</em> (que recebe uma parecida e não sabe).</li>
        <li><strong>2.</strong> <em>Sr. Branco</em> não recebe palavra. Ele joga com os Espiões e deve se infiltrar.</li>
        <li><strong>3.</strong> Na sua vez, dê <strong>uma pista</strong> curta sobre sua palavra.</li>
        <li><strong>4.</strong> Proibido repetir pistas ou falar a palavra diretamente.</li>
        <li><strong>5.</strong> Objetivo dos Inocentes: Expulsar os Espiões e o Sr. Branco.</li>
        <li><strong>6.</strong> Objetivo dos Impostores: Não serem descobertos.</li>
        <li><strong>7.</strong> A cada rodada ocorre uma votação para eliminar um suspeito.</li>
        <li><strong>8.</strong> Se o <em>Sr. Branco</em> for eliminado, ele tem uma chance de chutar a palavra para vencer.</li>
        <li><strong>9.</strong> <span style={{color: '#ffd700'}}>A PALAVRA CORRETA É A DOS CIVIS!</span></li>
      </ul>
    </div>
  );

                                                                                                                                           // --- COMPONENTE DE RODAPÉ ---
  // --- COMPONENTE DE RODAPÉ (ATUALIZADO COM LINK) ---
  const Footer = () => (
    <div className="site-footer">
      Desenvolvido e Projetado por 
      {/* Troque o href abaixo pelo link do seu perfil real */}
      <a href="https://kadevpt.vercel.app/" target="_blank" rel="noopener noreferrer">
        <strong>Kleidson Almeida Santos</strong>
      </a>
    </div>
  );

  // --- TELA DE LOGIN (ENTRADA) ---
  if (!joined) {
    return (
      <>
        <div className="container login-screen">
          {/* Título Personalizado com Logo */}
          <h1 className="game-title">
            <img src="/spylogo.png" alt="Logo Spy" className="title-logo" />
            SPY & WHITE GAME
          </h1>
          
          <div className="input-group">
            <label>SEU APELIDO</label>
            <input 
              placeholder="Ex: João" 
              value={playerName} 
              onChange={(e) => setPlayerName(e.target.value)} 
            />
          </div>

          <div className="input-group">
            <label>NOME DA SALA</label>
            <input 
              placeholder="Ex: Batata" 
              value={roomId} 
              onChange={(e) => setRoomId(e.target.value)} 
            />
          </div>
          
          <button className="btn-primary btn-large" onClick={joinRoom}>
            ENTRAR NA SALA
          </button>
        </div>

        {/* Elementos Fixos */}
        <RulesBox />
        <Footer />
      </>
    );
  }

  // --- TELA DE CARREGAMENTO ---
  if (!gameState) return <div className="container"><h2>Conectando...</h2></div>;

  const me = gameState.players.find((p) => p.id === socket.id);
  if (!me) return <div className="container">Erro: Reinicie a página.</div>;

  const currentPlayer = gameState.players[gameState.turnIndex];
  const isMyTurn = gameState.phase === 'DESCRIPTION' && currentPlayer?.id === socket.id;

  // --- JOGO PRINCIPAL ---
  return (
    <>
      <div className="container">
        <header>
          <div className="room-badge">Sala: {roomId}</div>
          {gameState.phase !== 'LOBBY' && (
            <div className={`secret-card ${me.role === 'mr_white' ? 'white-role' : ''}`}>
               {me.role === 'mr_white' 
                  ? <span>VOCÊ É O SR. BRANCO! 🤫</span> 
                  : <span>Sua palavra: <strong>{me.word}</strong></span>
               }
            </div>
          )}
        </header>

        {/* LOBBY (SALA DE ESPERA) */}
        {gameState.phase === 'LOBBY' && (
          <div className="phase-box">
            <h2>Quem vai jogar? ({gameState.players.length})</h2>
            <ul className="player-list">
              {gameState.players.map(p => (
                  <li key={p.id}>
                      {p.name} {p.id === socket.id && ' (Você)'}
                  </li>
              ))}
            </ul>
            
            {/* ÁREA DE CONFIGURAÇÃO (Visível para todos) */}
            <div className="settings-box" style={{margin: '20px 0', padding: '15px', background: 'rgba(0,0,0,0.3)', borderRadius: '10px'}}>
               <h3>Configurar Partida</h3>
               
               <div className="setting-row" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px'}}>
                 <span>⚪ Sr. Branco:</span>
                 <div className="controls">
                   <button className="btn-small" onClick={() => changeSettings('mrWhiteCount', -1)}>-</button>
                   <span style={{margin: '0 10px', fontSize: '1.2em', fontWeight: 'bold'}}>{gameState.settings?.mrWhiteCount || 0}</span>
                   <button className="btn-small" onClick={() => changeSettings('mrWhiteCount', 1)}>+</button>
                 </div>
               </div>

               <div className="setting-row" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                 <span>🕵️‍♂️ Espiões:</span>
                 <div className="controls">
                   <button className="btn-small" onClick={() => changeSettings('undercoverCount', -1)}>-</button>
                   <span style={{margin: '0 10px', fontSize: '1.2em', fontWeight: 'bold'}}>{gameState.settings?.undercoverCount || 0}</span>
                   <button className="btn-small" onClick={() => changeSettings('undercoverCount', 1)}>+</button>
                 </div>
               </div>
               
               <p style={{fontSize: '0.8em', marginTop: '15px', color: '#ccc'}}>
                  Total de Inimigos: {(gameState.settings?.mrWhiteCount || 0) + (gameState.settings?.undercoverCount || 0)} 
                  <br/> (O restante dos jogadores serão Civis)
               </p>
            </div>

            <button 
              className="btn-primary" 
              onClick={startGame} 
              disabled={gameState.players.length < 3}
            >
              {gameState.players.length < 3 ? 'Aguardando Jogadores (Min 3)...' : 'COMEÇAR PARTIDA AGORA'}
            </button>
          </div>
        )}

        {/* FASE DE DESCRIÇÃO */}
        {gameState.phase === 'DESCRIPTION' && (
          <div className="phase-box">
            <h3>📢 Hora da Descrição</h3>
            <p>Vez de: <strong style={{color: '#ffd700'}}>{currentPlayer?.name}</strong></p>
            
            <div className="descriptions-log">
               {gameState.players.map(p => (
                 <div key={p.id} className={`player-msg ${!p.isAlive ? 'dead' : ''}`}>
                   <strong>{p.name}:</strong> {p.description ? `"${p.description}"` : '...'}
                 </div>
               ))}
            </div>

            {isMyTurn && me.isAlive && (
              <div className="action-area">
                <input 
                  autoFocus
                  value={descriptionInput} 
                  onChange={(e) => setDescriptionInput(e.target.value)} 
                  placeholder="Descreva sua palavra com 1 termo..."
                />
                <button className="btn-primary" onClick={sendDescription}>ENVIAR</button>
              </div>
            )}
          </div>
        )}

        {/* FASE DE VOTAÇÃO */}
        {gameState.phase === 'VOTING' && (
          <div className="phase-box">
            <h3 style={{color: '#ff4757'}}>☠️ Eliminação</h3>
            <p>Clique em quem você suspeita:</p>
            <div className="grid-vote">
              {gameState.players.map(p => (
                p.isAlive && p.id !== socket.id && (
                  <button key={p.id} className="btn-danger" onClick={() => votePlayer(p.id)}>
                     {p.name}
                  </button>
                )
              ))}
            </div>
            <p style={{fontSize: '0.8em', marginTop: '10px'}}>Seus votos recebidos: {me.votes}</p>
          </div>
        )}

        {/* CHANCE DO MR WHITE */}
        {gameState.phase === 'MR_WHITE_GUESS' && (
          <div className="phase-box">
            <h3 style={{color: '#ffd700'}}>Sr. Branco Encurralado!</h3>
            <p>Ele tem uma chance de adivinhar.</p>
            {me.role === 'mr_white' && !me.isAlive && (
               <div className="action-area">
                 <input 
                    autoFocus
                    placeholder="Qual é a palavra dos civis?" 
                    value={mrWhiteGuess} 
                    onChange={(e) => setMrWhiteGuess(e.target.value)} 
                 />
                 <button className="btn-primary" onClick={sendMrWhiteGuess}>TENTAR SALVAR</button>
               </div>
            )}
          </div>
        )}

        {/* FIM DE JOGO */}
        {gameState.phase === 'GAME_OVER' && (
          <div className="phase-box">
            <h1>🏆 Fim de Jogo!</h1>
            
            <h2 style={{color: '#ffd700'}}>
              {gameState.winner === 'CIVILIANS_WIN' && 'Civis Venceram!'}
              {gameState.winner === 'IMPOSTORS_WIN' && 'Impostores Venceram!'}
              {gameState.winner === 'MR_WHITE_WINS' && 'Sr. Branco Venceu!'}
            </h2>

            {gameState.wordPair && (
              <div className="reveal-box">
                <p>Civis: <strong>{gameState.wordPair.civilian}</strong></p>
                <p>Impostor: <strong>{gameState.wordPair.undercover}</strong></p>
              </div>
            )}
            <button className="btn-primary" onClick={startGame}>JOGAR NOVAMENTE</button>
          </div>
        )}
        
        <div className="scoreboard">
            <h4>Placar</h4>
            <div className="score-list">
              {gameState.players.map(p => <span key={p.id}>{p.name}: <strong>{p.score}</strong></span>)}
            </div>
        </div>
      </div>

      {/* Elementos Fixos */}
      <RulesBox />
      <Footer />
    </>
  );
}

export default App;
