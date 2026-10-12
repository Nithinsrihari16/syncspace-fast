import React, { useState, useEffect, useRef, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import axios from 'axios';

// Get backend URL from Vercel environment variables or fall back to Render production
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://syncspace-fast.onrender.com';
const WS_URL = BACKEND_URL.replace(/^http/, 'ws') + '/ws';

const LANGUAGES = [
  {
    label: 'JavaScript',
    value: 'javascript',
    monacoLang: 'javascript',
    fileExt: 'js',
    fileName: 'index.js',
    defaultCode: `// Welcome to SyncSpace - Real-Time Collaborative JavaScript\nconsole.log("⚡ SyncSpace collaborative editor ready!");\n\nfunction calculateStats(numbers) {\n  const sum = numbers.reduce((acc, curr) => acc + curr, 0);\n  const average = sum / numbers.length;\n  const max = Math.max(...numbers);\n  const min = Math.min(...numbers);\n  return { count: numbers.length, sum, average: average.toFixed(2), min, max };\n}\n\nconst sampleData = [15, 42, 88, 23, 7, 91, 54, 60];\nconsole.log("Analyzing dataset:", sampleData);\nconsole.log("Computed statistics:", calculateStats(sampleData));\n`
  },
  {
    label: 'Python',
    value: 'python',
    monacoLang: 'python',
    fileExt: 'py',
    fileName: 'main.py',
    defaultCode: `# Welcome to SyncSpace - Real-Time Collaborative Python\nprint("⚡ SyncSpace collaborative editor ready!")\n\ndef calculate_stats(numbers):\n    total = sum(numbers)\n    avg = total / len(numbers)\n    return {\n        "count": len(numbers),\n        "sum": total,\n        "average": round(avg, 2),\n        "min": min(numbers),\n        "max": max(numbers)\n    }\n\nsample_data = [15, 42, 88, 23, 7, 91, 54, 60]\nprint(f"Analyzing dataset: {sample_data}")\nprint(f"Computed statistics: {calculate_stats(sample_data)}")\n`
  },
  {
    label: 'C++',
    value: 'cpp',
    monacoLang: 'cpp',
    fileExt: 'cpp',
    fileName: 'main.cpp',
    defaultCode: `// Welcome to SyncSpace - Real-Time Collaborative C++\n#include <iostream>\n#include <vector>\n#include <numeric>\n#include <algorithm>\n\nusing namespace std;\n\nint main() {\n    cout << "⚡ SyncSpace C++ session initialized!" << endl;\n    vector<int> numbers = {15, 42, 88, 23, 7, 91, 54, 60};\n    \n    int sum = accumulate(numbers.begin(), numbers.end(), 0);\n    double avg = static_cast<double>(sum) / numbers.size();\n    \n    cout << "Dataset count: " << numbers.size() << endl;\n    cout << "Sum: " << sum << ", Average: " << avg << endl;\n    return 0;\n}\n`
  },
  {
    label: 'Java',
    value: 'java',
    monacoLang: 'java',
    fileExt: 'java',
    fileName: 'Main.java',
    defaultCode: `// Welcome to SyncSpace - Real-Time Collaborative Java\nimport java.util.Arrays;\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("⚡ SyncSpace Java session initialized!");\n        int[] numbers = {15, 42, 88, 23, 7, 91, 54, 60};\n        \n        int sum = Arrays.stream(numbers).sum();\n        double avg = (double) sum / numbers.length;\n        \n        System.out.println("Dataset count: " + numbers.length);\n        System.out.println("Sum: " + sum + ", Average: " + avg);\n    }\n}\n`
  }
];

export default function App() {
  const [language, setLanguage] = useState('javascript');
  const [code, setCode] = useState(LANGUAGES[0].defaultCode);
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [executionMeta, setExecutionMeta] = useState(null); // { status, time, returncode, timestamp }
  const [users, setUsers] = useState([]);
  const [userCount, setUserCount] = useState(1);
  const [currentUser, setCurrentUser] = useState(null);
  const [wsStatus, setWsStatus] = useState('connecting'); // 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  const [notifications, setNotifications] = useState([]);
  const [copied, setCopied] = useState(false);

  const socketRef = useRef(null);
  const codeRef = useRef(code);
  const languageRef = useRef(language);
  const isRemoteUpdateRef = useRef(false);
  const reconnectTimeoutRef = useRef(null);
  const editorRef = useRef(null);

  codeRef.current = code;
  languageRef.current = language;

  // Add toast notification helper
  const addNotification = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random();
    setNotifications((prev) => [...prev.slice(-3), { id, message, type }]);
    setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, 4000);
  }, []);

  // WebSocket Connection Management
  const connectWebSocket = useCallback(() => {
    if (socketRef.current) {
      try {
        socketRef.current.close();
      } catch (e) {
        // ignore
      }
    }

    setWsStatus('connecting');

    try {
      const ws = new WebSocket(WS_URL);
      socketRef.current = ws;

      ws.onopen = () => {
        setWsStatus('connected');
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'init') {
            setCurrentUser(data.self);
            if (Array.isArray(data.users)) setUsers(data.users);
            if (typeof data.count === 'number') setUserCount(data.count);
            if (data.code && data.code !== codeRef.current) {
              isRemoteUpdateRef.current = true;
              setCode(data.code);
            }
            if (data.language && LANGUAGES.some(l => l.value === data.language)) {
              setLanguage(data.language);
            }
          } else if (data.type === 'user_connected') {
            if (Array.isArray(data.users)) setUsers(data.users);
            if (typeof data.count === 'number') setUserCount(data.count);
            const peerName = data.user?.name || 'A new peer';
            addNotification(`🟢 ${peerName} joined the session`, 'connect');
          } else if (data.type === 'user_disconnected') {
            if (Array.isArray(data.users)) setUsers(data.users);
            if (typeof data.count === 'number') setUserCount(data.count);
            const peerName = data.user?.name || 'A peer';
            addNotification(`⚪ ${peerName} left the session`, 'disconnect');
          } else if (data.type === 'count_update') {
            if (typeof data.count === 'number') setUserCount(data.count);
          } else if (data.type === 'code_update') {
            if (data.code !== undefined && data.code !== codeRef.current) {
              isRemoteUpdateRef.current = true;
              setCode(data.code);
            }
            if (data.language && data.language !== languageRef.current) {
              setLanguage(data.language);
            }
          } else if (data.type === 'language_change') {
            if (data.language && data.language !== languageRef.current) {
              setLanguage(data.language);
            }
            if (data.code !== undefined && data.code !== codeRef.current) {
              isRemoteUpdateRef.current = true;
              setCode(data.code);
            }
          }
        } catch (e) {
          // Fallback: If raw text code was sent
          if (event.data !== codeRef.current) {
            isRemoteUpdateRef.current = true;
            setCode(event.data);
          }
        }
      };

      ws.onclose = () => {
        setWsStatus('reconnecting');
        // Auto-reconnect after 2.5 seconds without crashing
        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connectWebSocket();
          }, 2500);
        }
      };

      ws.onerror = () => {
        setWsStatus('reconnecting');
      };
    } catch (err) {
      setWsStatus('disconnected');
      if (!reconnectTimeoutRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, 3000);
      }
    }
  }, [addNotification]);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, [connectWebSocket]);

  // Handle local code changes
  const handleCodeChange = (newCode) => {
    const updatedCode = newCode || '';
    if (isRemoteUpdateRef.current) {
      isRemoteUpdateRef.current = false;
      return;
    }
    setCode(updatedCode);

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'code_change',
          code: updatedCode,
          language
        })
      );
    }
  };

  // Handle language switch
  const handleLanguageChange = (e) => {
    const selectedLangValue = e.target.value;
    const langObj = LANGUAGES.find((l) => l.value === selectedLangValue);
    if (!langObj) return;

    const newCode = langObj.defaultCode;
    setLanguage(selectedLangValue);
    setCode(newCode);

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'language_change',
          language: selectedLangValue,
          code: newCode
        })
      );
    }
  };

  // Reset to default template
  const handleResetTemplate = () => {
    const currentLangObj = LANGUAGES.find((l) => l.value === language) || LANGUAGES[0];
    setCode(currentLangObj.defaultCode);
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: 'code_change',
          code: currentLangObj.defaultCode,
          language
        })
      );
    }
    addNotification('Template reset to default', 'info');
  };

  // Execute Code
  const runCode = async () => {
    if (loading) return;
    setLoading(true);
    setExecutionMeta({ status: 'running' });

    try {
      const response = await axios.post(`${BACKEND_URL}/execute`, {
        language,
        code
      });

      const resData = response.data;
      setOutput(resData.output || 'Code executed with no output.');
      setExecutionMeta({
        status: resData.status || 'success',
        executionTime: resData.execution_time,
        returncode: resData.returncode ?? 0,
        timestamp: new Date().toLocaleTimeString()
      });
    } catch (err) {
      const errMsg = err.response?.data?.detail || err.message || 'Error executing code.';
      setOutput(`Execution Error:\n${errMsg}\n\nPlease check if FastAPI backend is running on ${BACKEND_URL}.`);
      setExecutionMeta({
        status: 'error',
        executionTime: 0,
        returncode: 1,
        timestamp: new Date().toLocaleTimeString()
      });
    } finally {
      setLoading(false);
    }
  };

  // Monaco Editor mount setup (shortcuts, styling)
  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
    // Add keyboard shortcut Ctrl+Enter or Cmd+Enter to execute code
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      runCode();
    });
  };

  // Copy output to clipboard
  const handleCopyOutput = () => {
    if (!output) return;
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const currentLangObj = LANGUAGES.find((l) => l.value === language) || LANGUAGES[0];

  return (
    <div style={styles.container}>
      {/* Toast Notification Overlay */}
      <div style={styles.toastContainer}>
        {notifications.map((n) => (
          <div
            key={n.id}
            style={{
              ...styles.toast,
              borderLeft: n.type === 'connect' ? '4px solid #10b981' : n.type === 'disconnect' ? '4px solid #f43f5e' : '4px solid #3b82f6'
            }}
          >
            {n.message}
          </div>
        ))}
      </div>

      {/* TOP NAVIGATION BAR */}
      <header style={styles.header}>
        {/* Brand Logo & Connection Badge */}
        <div style={styles.headerLeft}>
          <div style={styles.brand}>
            <div style={styles.brandIconWrapper}>
              <span style={styles.brandIcon}>⚡</span>
            </div>
            <div>
              <div style={styles.brandTitle}>SyncSpace</div>
              <div style={styles.brandSubtitle}>Collaborative Studio</div>
            </div>
          </div>

          <div
            style={{
              ...styles.statusBadge,
              backgroundColor:
                wsStatus === 'connected'
                  ? 'rgba(16, 185, 129, 0.15)'
                  : wsStatus === 'reconnecting'
                    ? 'rgba(245, 158, 11, 0.15)'
                    : 'rgba(244, 63, 94, 0.15)',
              color:
                wsStatus === 'connected'
                  ? '#34d399'
                  : wsStatus === 'reconnecting'
                    ? '#fbbf24'
                    : '#f87171'
            }}
            title={wsStatus === 'connected' ? 'WebSocket live' : 'Attempting to reconnect...'}
          >
            <span
              style={{
                ...styles.statusDot,
                backgroundColor:
                  wsStatus === 'connected'
                    ? '#10b981'
                    : wsStatus === 'reconnecting'
                      ? '#f59e0b'
                      : '#f43f5e',
                animation: wsStatus === 'connected' ? 'pulse-dot 2s infinite' : 'none'
              }}
            />
            {wsStatus === 'connected' ? 'Online' : wsStatus === 'reconnecting' ? 'Reconnecting' : 'Offline'}
          </div>
        </div>

        {/* Live Connected Users Counter & Avatars */}
        <div style={styles.headerCenter}>
          <div style={styles.liveCounterContainer}>
            <div style={styles.liveCounterBadge}>
              <span style={styles.liveGreenDot} />
              <span style={styles.liveCounterText}>
                {userCount} {userCount === 1 ? 'User' : 'Users'} Online
              </span>
            </div>

            {/* Active User Avatars */}
            <div style={styles.avatarList}>
              {users.map((u, idx) => {
                const isSelf = currentUser && currentUser.id === u.id;
                const initials = u.name ? u.name.replace(/[^0-9]/g, '') : `${idx + 1}`;
                return (
                  <div
                    key={u.id || idx}
                    style={{
                      ...styles.avatar,
                      backgroundColor: u.color || '#4f46e5',
                      border: isSelf ? '2px solid #ffffff' : '2px solid #1e2029',
                      zIndex: users.length - idx
                    }}
                    title={`${u.name || 'Coder'}${isSelf ? ' (You)' : ''}`}
                  >
                    {isSelf ? 'You' : `C${initials || idx + 1}`}
                  </div>
                );
              })}
              {users.length === 0 && (
                <div
                  style={{
                    ...styles.avatar,
                    backgroundColor: '#4f46e5',
                    border: '2px solid #ffffff'
                  }}
                  title="You"
                >
                  You
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Language selector & Run Code Button */}
        <div style={styles.headerRight}>
          <div style={styles.languageSelectWrapper}>
            <span style={styles.selectIcon}>🌐</span>
            <select
              value={language}
              onChange={handleLanguageChange}
              style={styles.languageSelect}
              title="Select programming language"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value} style={styles.selectOption}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleResetTemplate}
            style={styles.resetButton}
            title="Reset editor to default code template"
          >
            ↺ Reset
          </button>

          <button
            onClick={runCode}
            disabled={loading}
            style={{
              ...styles.runButton,
              opacity: loading ? 0.75 : 1,
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
            title="Run Code (Ctrl + Enter)"
          >
            {loading ? (
              <>
                <span style={styles.spinner} />
                <span>Running...</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: '1.05rem', marginRight: '6px' }}>▶</span>
                <span>Run Code</span>
                <span style={styles.shortcutPill}>Ctrl ↵</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* DUAL-PANE MAIN WORKSPACE */}
      <main style={styles.main}>
        {/* LEFT PANE: Monaco Code Editor */}
        <section style={styles.editorPane}>
          {/* Editor Tab Header */}
          <div style={styles.paneHeader}>
            <div style={styles.tabActive}>
              <span style={styles.fileIcon}>📄</span>
              <span style={styles.fileName}>{currentLangObj.fileName}</span>
              <span style={styles.langPill}>{currentLangObj.label}</span>
            </div>
            <div style={styles.editorMeta}>
              <span style={styles.metaHint}>Collaborative Sync Active</span>
            </div>
          </div>

          {/* Monaco Editor Container */}
          <div style={styles.editorWrapper}>
            <Editor
              height="100%"
              theme="vs-dark"
              language={currentLangObj.monacoLang}
              value={code}
              onChange={handleCodeChange}
              onMount={handleEditorDidMount}
              options={{
                fontSize: 14,
                fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
                lineNumbers: 'on',
                roundedSelection: false,
                scrollBeyondLastLine: false,
                readOnly: false,
                automaticLayout: true,
                tabSize: 4,
                minimap: { enabled: false },
                cursorBlinking: 'smooth',
                renderLineHighlight: 'all',
                smoothScrolling: true,
                padding: { top: 12, bottom: 12 }
              }}
            />
          </div>
        </section>

        {/* RIGHT PANE: Styled Output Console */}
        <section style={styles.consolePane}>
          {/* Console Header */}
          <div style={styles.consoleHeader}>
            <div style={styles.consoleTitleGroup}>
              <span style={styles.consoleIcon}>🖥️</span>
              <span style={styles.consoleTitle}>TERMINAL / OUTPUT</span>

              {executionMeta?.status && (
                <span
                  style={{
                    ...styles.statusTag,
                    backgroundColor:
                      executionMeta.status === 'running'
                        ? 'rgba(59, 130, 246, 0.2)'
                        : executionMeta.status === 'success'
                          ? 'rgba(16, 185, 129, 0.2)'
                          : 'rgba(244, 63, 94, 0.2)',
                    color:
                      executionMeta.status === 'running'
                        ? '#60a5fa'
                        : executionMeta.status === 'success'
                          ? '#34d399'
                          : '#f87171',
                    borderColor:
                      executionMeta.status === 'running'
                        ? '#3b82f6'
                        : executionMeta.status === 'success'
                          ? '#10b981'
                          : '#f43f5e'
                  }}
                >
                  {executionMeta.status === 'running'
                    ? 'RUNNING'
                    : executionMeta.status === 'success'
                      ? 'SUCCESS (0)'
                      : 'ERROR'}
                </span>
              )}

              {executionMeta?.executionTime !== undefined && (
                <span style={styles.timeTag}>
                  ⏱ {executionMeta.executionTime}ms
                </span>
              )}
            </div>

            <div style={styles.consoleActions}>
              {output && (
                <button
                  onClick={handleCopyOutput}
                  style={styles.consoleActionButton}
                  title="Copy terminal output"
                >
                  {copied ? '✓ Copied' : '📋 Copy'}
                </button>
              )}
              <button
                onClick={() => {
                  setOutput('');
                  setExecutionMeta(null);
                }}
                style={styles.consoleActionButton}
                title="Clear console"
              >
                🗑 Clear
              </button>
            </div>
          </div>

          {/* Console Terminal Output Area */}
          <div style={styles.consoleBody}>
            {loading ? (
              <div style={styles.loadingOutput}>
                <span style={styles.spinnerLarge} />
                <div style={{ marginTop: '12px', color: '#94a3b8' }}>
                  Executing {currentLangObj.label} code in isolated environment...
                </div>
              </div>
            ) : output ? (
              <div style={styles.outputContent}>
                <div style={styles.terminalPrompt}>
                  <span style={{ color: '#10b981' }}>syncspace@cloud</span>
                  <span style={{ color: '#64748b' }}>:</span>
                  <span style={{ color: '#38bdf8' }}>~</span>
                  <span style={{ color: '#64748b' }}>$</span>
                  <span style={{ color: '#e2e8f0', marginLeft: '6px' }}>
                    run {currentLangObj.fileName}
                  </span>
                </div>
                <pre
                  style={{
                    ...styles.terminalText,
                    color: executionMeta?.status === 'error' ? '#fca5a5' : '#34d399'
                  }}
                >
                  {output}
                </pre>
                {executionMeta?.timestamp && (
                  <div style={styles.terminalFooter}>
                    --- Finished at {executionMeta.timestamp} in {executionMeta.executionTime}ms ---
                  </div>
                )}
              </div>
            ) : (
              <div style={styles.emptyConsole}>
                <div style={styles.emptyConsoleIcon}>⚡</div>
                <div style={styles.emptyConsoleTitle}>Output Console Ready</div>
                <div style={styles.emptyConsoleDesc}>
                  Write code and click <strong style={{ color: '#34d399' }}>'Run Code'</strong> or press{' '}
                  <kbd style={styles.kbd}>Ctrl + Enter</kbd> to see real-time compilation and execution results here.
                </div>
                <div style={styles.emptyConsoleTips}>
                  <div style={styles.tipItem}>
                    <span style={styles.tipBullet}>•</span> Python and JavaScript execute immediately via native engine.
                  </div>
                  <div style={styles.tipItem}>
                    <span style={styles.tipBullet}>•</span> Changes in the editor sync automatically with all connected peers.
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

// STYLES OBJECT FOR PIXEL-PERFECT DARK MODERN IDE UI
const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    backgroundColor: '#0f1117',
    color: '#e2e8f0',
    overflow: 'hidden',
    position: 'relative'
  },
  toastContainer: {
    position: 'absolute',
    top: '70px',
    right: '24px',
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    pointerEvents: 'none'
  },
  toast: {
    backgroundColor: '#1e2230',
    color: '#f8fafc',
    padding: '10px 16px',
    borderRadius: '8px',
    fontSize: '0.85rem',
    fontWeight: '500',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
    border: '1px solid #2d3345',
    animation: 'toast-in 0.25s ease-out',
    pointerEvents: 'auto'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0 20px',
    height: '62px',
    backgroundColor: '#161821',
    borderBottom: '1px solid #262936',
    flexShrink: 0,
    zIndex: 100
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px'
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    cursor: 'pointer',
    userSelect: 'none'
  },
  brandIconWrapper: {
    width: '34px',
    height: '34px',
    borderRadius: '8px',
    background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 0 14px rgba(59, 130, 246, 0.35)'
  },
  brandIcon: {
    fontSize: '1.15rem'
  },
  brandTitle: {
    fontSize: '1.15rem',
    fontWeight: '700',
    letterSpacing: '-0.4px',
    color: '#ffffff',
    lineHeight: 1.1
  },
  brandSubtitle: {
    fontSize: '0.68rem',
    color: '#94a3b8',
    letterSpacing: '0.4px',
    textTransform: 'uppercase'
  },
  statusBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 10px',
    borderRadius: '12px',
    fontSize: '0.75rem',
    fontWeight: '600'
  },
  statusDot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    display: 'inline-block'
  },
  headerCenter: {
    display: 'flex',
    alignItems: 'center'
  },
  liveCounterContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    backgroundColor: '#1e212d',
    padding: '6px 14px',
    borderRadius: '24px',
    border: '1px solid #2d3345'
  },
  liveCounterBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  },
  liveGreenDot: {
    width: '9px',
    height: '9px',
    borderRadius: '50%',
    backgroundColor: '#10b981',
    display: 'inline-block',
    animation: 'pulse-dot 2s infinite'
  },
  liveCounterText: {
    fontSize: '0.85rem',
    fontWeight: '600',
    color: '#f1f5f9'
  },
  avatarList: {
    display: 'flex',
    alignItems: 'center',
    marginLeft: '6px'
  },
  avatar: {
    width: '26px',
    height: '26px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.68rem',
    fontWeight: '700',
    color: '#ffffff',
    marginLeft: '-6px',
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.3)',
    cursor: 'default',
    transition: 'transform 0.15s ease',
    userSelect: 'none'
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px'
  },
  languageSelectWrapper: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center'
  },
  selectIcon: {
    position: 'absolute',
    left: '10px',
    fontSize: '0.85rem',
    pointerEvents: 'none'
  },
  languageSelect: {
    padding: '7px 12px 7px 32px',
    backgroundColor: '#1f2330',
    color: '#f8fafc',
    border: '1px solid #33394d',
    borderRadius: '6px',
    fontSize: '0.85rem',
    fontWeight: '500',
    cursor: 'pointer',
    outline: 'none',
    appearance: 'auto'
  },
  selectOption: {
    backgroundColor: '#1f2330',
    color: '#ffffff'
  },
  resetButton: {
    padding: '7px 12px',
    backgroundColor: '#232736',
    color: '#cbd5e1',
    border: '1px solid #363d52',
    borderRadius: '6px',
    fontSize: '0.82rem',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background-color 0.15s'
  },
  runButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '8px 18px',
    background: 'linear-gradient(135deg, #10b981, #059669)',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.88rem',
    fontWeight: '700',
    boxShadow: '0 2px 12px rgba(16, 185, 129, 0.35)',
    transition: 'all 0.15s ease',
    userSelect: 'none'
  },
  shortcutPill: {
    marginLeft: '8px',
    padding: '2px 5px',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderRadius: '4px',
    fontSize: '0.7rem',
    color: 'rgba(255, 255, 255, 0.85)',
    fontWeight: '600'
  },
  spinner: {
    width: '14px',
    height: '14px',
    border: '2px solid rgba(255, 255, 255, 0.3)',
    borderTopColor: '#ffffff',
    borderRadius: '50%',
    display: 'inline-block',
    marginRight: '8px',
    animation: 'spin 0.8s linear infinite'
  },
  main: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    height: 'calc(100vh - 62px)'
  },
  editorPane: {
    flex: 6,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#1e1e1e',
    borderRight: '1px solid #262936',
    overflow: 'hidden'
  },
  paneHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '38px',
    backgroundColor: '#191b24',
    borderBottom: '1px solid #262936',
    padding: '0 14px'
  },
  tabActive: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '0.82rem',
    fontWeight: '600',
    color: '#f8fafc'
  },
  fileIcon: {
    fontSize: '0.9rem'
  },
  fileName: {
    color: '#38bdf8'
  },
  langPill: {
    fontSize: '0.68rem',
    padding: '2px 6px',
    backgroundColor: '#262d40',
    color: '#93c5fd',
    borderRadius: '4px',
    fontWeight: '500'
  },
  editorMeta: {
    display: 'flex',
    alignItems: 'center'
  },
  metaHint: {
    fontSize: '0.72rem',
    color: '#64748b'
  },
  editorWrapper: {
    flex: 1,
    overflow: 'hidden'
  },
  consolePane: {
    flex: 4,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#0c0d12',
    overflow: 'hidden'
  },
  consoleHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '38px',
    backgroundColor: '#14161f',
    borderBottom: '1px solid #242733',
    padding: '0 16px'
  },
  consoleTitleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px'
  },
  consoleIcon: {
    fontSize: '0.85rem'
  },
  consoleTitle: {
    fontSize: '0.78rem',
    fontWeight: '700',
    letterSpacing: '0.5px',
    color: '#cbd5e1'
  },
  statusTag: {
    fontSize: '0.68rem',
    fontWeight: '700',
    padding: '2px 7px',
    borderRadius: '4px',
    border: '1px solid transparent'
  },
  timeTag: {
    fontSize: '0.72rem',
    color: '#94a3b8'
  },
  consoleActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px'
  },
  consoleActionButton: {
    padding: '4px 8px',
    backgroundColor: '#1f2330',
    color: '#94a3b8',
    border: '1px solid #2d3345',
    borderRadius: '4px',
    fontSize: '0.72rem',
    cursor: 'pointer',
    transition: 'all 0.15s'
  },
  consoleBody: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    padding: '16px',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
    backgroundColor: '#0c0d12'
  },
  loadingOutput: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%'
  },
  spinnerLarge: {
    width: '32px',
    height: '32px',
    border: '3px solid rgba(59, 130, 246, 0.2)',
    borderTopColor: '#3b82f6',
    borderRadius: '50%',
    display: 'inline-block',
    animation: 'spin 0.8s linear infinite'
  },
  outputContent: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%'
  },
  terminalPrompt: {
    fontSize: '0.82rem',
    marginBottom: '10px',
    display: 'flex',
    alignItems: 'center'
  },
  terminalText: {
    margin: 0,
    fontSize: '0.88rem',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    flex: 1
  },
  terminalFooter: {
    marginTop: '16px',
    paddingTop: '10px',
    borderTop: '1px solid #1f2330',
    fontSize: '0.72rem',
    color: '#64748b'
  },
  emptyConsole: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    textAlign: 'center',
    padding: '20px'
  },
  emptyConsoleIcon: {
    fontSize: '2.5rem',
    marginBottom: '12px',
    opacity: 0.4
  },
  emptyConsoleTitle: {
    fontSize: '1rem',
    fontWeight: '600',
    color: '#cbd5e1',
    marginBottom: '8px'
  },
  emptyConsoleDesc: {
    fontSize: '0.82rem',
    color: '#64748b',
    maxWidth: '380px',
    lineHeight: '1.5',
    marginBottom: '20px'
  },
  kbd: {
    padding: '2px 6px',
    backgroundColor: '#1e2230',
    border: '1px solid #333a4f',
    borderRadius: '4px',
    fontSize: '0.75rem',
    color: '#e2e8f0'
  },
  emptyConsoleTips: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    textAlign: 'left',
    fontSize: '0.78rem',
    color: '#475569',
    backgroundColor: '#12141c',
    padding: '12px 16px',
    borderRadius: '8px',
    border: '1px solid #1d212d'
  },
  tipItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px'
  },
  tipBullet: {
    color: '#10b981'
  }
};