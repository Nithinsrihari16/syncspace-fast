import os
import sys
import time
import uuid
import json
import shutil
import tempfile
import subprocess
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="SyncSpace Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class CodeRequest(BaseModel):
    language: str
    code: str

# In-memory document state to provide new joiners with current collaborative code & language
class DocumentState:
    def __init__(self):
        self.language: str = "javascript"
        self.code: str = (
            "// Welcome to SyncSpace - Real-Time Collaborative Code Editor\n"
            "console.log(\"Hello SyncSpace!\");\n\n"
            "function fibonacci(n) {\n"
            "    if (n <= 1) return n;\n"
            "    return fibonacci(n - 1) + fibonacci(n - 2);\n"
            "}\n\n"
            "console.log(\"Fibonacci sequence (first 8 numbers):\");\n"
            "for (let i = 0; i < 8; i++) {\n"
            "    console.log(`F(${i}) = ${fibonacci(i)}`);\n"
            "}\n"
        )

doc_state = DocumentState()

class ConnectionManager:
    def __init__(self):
        # Maps active WebSocket connections to user metadata dict
        self.active_connections: Dict[WebSocket, dict] = {}
        self.counter: int = 0
        self.avatar_colors = [
            "#4F46E5",  # Indigo
            "#06B6D4",  # Cyan
            "#10B981",  # Emerald
            "#F59E0B",  # Amber
            "#EC4899",  # Pink
            "#8B5CF6",  # Purple
            "#3B82F6",  # Blue
            "#14B8A6",  # Teal
            "#F97316",  # Orange
            "#E11D48",  # Rose
        ]

    def get_user_count(self) -> int:
        return len(self.active_connections)

    def get_users_list(self) -> List[dict]:
        return [
            {
                "id": info["id"],
                "name": info["name"],
                "color": info["color"],
                "joined_at": info.get("joined_at", time.time())
            }
            for info in self.active_connections.values()
        ]

    async def connect(self, websocket: WebSocket) -> dict:
        await websocket.accept()
        self.counter += 1
        user_id = f"user_{uuid.uuid4().hex[:6]}"
        user_name = f"Coder #{self.counter}"
        color = self.avatar_colors[(self.counter - 1) % len(self.avatar_colors)]
        user_info = {
            "id": user_id,
            "name": user_name,
            "color": color,
            "joined_at": time.time()
        }
        self.active_connections[websocket] = user_info

        # 1. Send initial state to the newly connected user
        initial_payload = {
            "type": "init",
            "self": user_info,
            "users": self.get_users_list(),
            "count": self.get_user_count(),
            "code": doc_state.code,
            "language": doc_state.language
        }
        await websocket.send_text(json.dumps(initial_payload))

        # 2. Broadcast presence event: user_connected and count_update to peers
        await self.broadcast_event({
            "type": "user_connected",
            "user": user_info,
            "count": self.get_user_count(),
            "users": self.get_users_list()
        }, exclude=websocket)

        await self.broadcast_event({
            "type": "count_update",
            "count": self.get_user_count()
        }, exclude=websocket)

        return user_info

    async def disconnect(self, websocket: WebSocket):
        user_info = self.active_connections.pop(websocket, None)
        if user_info:
            current_count = self.get_user_count()
            # Broadcast presence event: user_disconnected and count_update to remaining peers
            await self.broadcast_event({
                "type": "user_disconnected",
                "user": user_info,
                "count": current_count,
                "users": self.get_users_list()
            })
            await self.broadcast_event({
                "type": "count_update",
                "count": current_count
            })

    async def broadcast_event(self, data: dict, exclude: Optional[WebSocket] = None):
        msg = json.dumps(data)
        disconnected = []
        for ws in list(self.active_connections.keys()):
            if ws != exclude:
                try:
                    await ws.send_text(msg)
                except Exception:
                    disconnected.append(ws)
        for ws in disconnected:
            self.active_connections.pop(ws, None)

    async def broadcast_code_update(self, code: str, language: Optional[str] = None, sender: Optional[WebSocket] = None):
        doc_state.code = code
        if language:
            doc_state.language = language
        sender_info = self.active_connections.get(sender, {})
        payload = {
            "type": "code_update",
            "code": code,
            "language": doc_state.language,
            "sender_id": sender_info.get("id", "anonymous")
        }
        await self.broadcast_event(payload, exclude=sender)

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            raw_data = await websocket.receive_text()
            try:
                msg = json.loads(raw_data)
                msg_type = msg.get("type")
                if msg_type == "code_change":
                    await manager.broadcast_code_update(
                        code=msg.get("code", ""),
                        language=msg.get("language"),
                        sender=websocket
                    )
                elif msg_type == "language_change":
                    doc_state.language = msg.get("language", doc_state.language)
                    if "code" in msg:
                        doc_state.code = msg["code"]
                    await manager.broadcast_event({
                        "type": "language_change",
                        "language": doc_state.language,
                        "code": doc_state.code
                    }, exclude=websocket)
                elif msg_type == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
                else:
                    if "code" in msg:
                        await manager.broadcast_code_update(code=msg["code"], sender=websocket)
            except json.JSONDecodeError:
                # Handle raw string code update for backward compatibility
                await manager.broadcast_code_update(code=raw_data, sender=websocket)
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception:
        await manager.disconnect(websocket)

@app.post("/execute")
def execute_code(req: CodeRequest):
    lang = req.language.lower().strip()
    code = req.code
    start_time = time.time()

    if len(code) > 100_000:
        return {
            "output": "Error: Code exceeds maximum allowed size (100KB).",
            "status": "error",
            "execution_time": 0
        }

    temp_dir = tempfile.mkdtemp(prefix="syncspace_")
    try:
        if lang in ["javascript", "js"]:
            file_path = os.path.join(temp_dir, "script.js")
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(code)

            node_bin = shutil.which("node") or "node"
            proc = subprocess.run(
                [node_bin, file_path],
                capture_output=True,
                text=True,
                timeout=8,
                cwd=temp_dir
            )
            elapsed = round((time.time() - start_time) * 1000, 2)
            output = proc.stdout if proc.returncode == 0 else (proc.stderr or proc.stdout)
            if not output and proc.returncode == 0:
                output = "Code executed successfully with no output."
            return {
                "output": output,
                "status": "success" if proc.returncode == 0 else "error",
                "returncode": proc.returncode,
                "execution_time": elapsed
            }

        elif lang in ["python", "py"]:
            file_path = os.path.join(temp_dir, "script.py")
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(code)

            python_bin = sys.executable or "python"
            proc = subprocess.run(
                [python_bin, file_path],
                capture_output=True,
                text=True,
                timeout=8,
                cwd=temp_dir
            )
            elapsed = round((time.time() - start_time) * 1000, 2)
            output = proc.stdout if proc.returncode == 0 else (proc.stderr or proc.stdout)
            if not output and proc.returncode == 0:
                output = "Code executed successfully with no output."
            return {
                "output": output,
                "status": "success" if proc.returncode == 0 else "error",
                "returncode": proc.returncode,
                "execution_time": elapsed
            }

        elif lang in ["cpp", "c++"]:
            file_path = os.path.join(temp_dir, "main.cpp")
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(code)

            gpp_bin = shutil.which("g++") or shutil.which("clang++")
            if not gpp_bin:
                return {
                    "output": "C++ compiler (g++) is not installed on this server environment.\nPython and JavaScript are fully supported and ready to execute.",
                    "status": "error",
                    "execution_time": 0
                }

            exe_path = os.path.join(temp_dir, "main.exe" if sys.platform == "win32" else "main.out")
            compile_proc = subprocess.run(
                [gpp_bin, file_path, "-o", exe_path],
                capture_output=True,
                text=True,
                timeout=8,
                cwd=temp_dir
            )
            if compile_proc.returncode != 0:
                return {
                    "output": f"Compilation Error:\n{compile_proc.stderr}",
                    "status": "error",
                    "execution_time": round((time.time() - start_time) * 1000, 2)
                }

            run_proc = subprocess.run(
                [exe_path],
                capture_output=True,
                text=True,
                timeout=5,
                cwd=temp_dir
            )
            elapsed = round((time.time() - start_time) * 1000, 2)
            output = run_proc.stdout if run_proc.returncode == 0 else (run_proc.stderr or run_proc.stdout)
            return {
                "output": output or "Program executed with no output.",
                "status": "success" if run_proc.returncode == 0 else "error",
                "execution_time": elapsed
            }

        elif lang in ["java"]:
            file_path = os.path.join(temp_dir, "Main.java")
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(code)

            javac_bin = shutil.which("javac")
            if not javac_bin:
                return {
                    "output": "Java compiler (javac) is not installed on this server environment.\nPython and JavaScript are fully supported and ready to execute.",
                    "status": "error",
                    "execution_time": 0
                }

            compile_proc = subprocess.run(
                [javac_bin, file_path],
                capture_output=True,
                text=True,
                timeout=8,
                cwd=temp_dir
            )
            if compile_proc.returncode != 0:
                return {
                    "output": f"Java Compilation Error:\n{compile_proc.stderr}",
                    "status": "error",
                    "execution_time": round((time.time() - start_time) * 1000, 2)
                }

            java_bin = shutil.which("java") or "java"
            run_proc = subprocess.run(
                [java_bin, "-cp", temp_dir, "Main"],
                capture_output=True,
                text=True,
                timeout=5,
                cwd=temp_dir
            )
            elapsed = round((time.time() - start_time) * 1000, 2)
            output = run_proc.stdout if run_proc.returncode == 0 else (run_proc.stderr or run_proc.stdout)
            return {
                "output": output or "Program executed with no output.",
                "status": "success" if run_proc.returncode == 0 else "error",
                "execution_time": elapsed
            }

        else:
            return {
                "output": f"Language '{req.language}' is not supported.",
                "status": "error",
                "execution_time": 0
            }

    except subprocess.TimeoutExpired:
        return {
            "output": "Execution timed out (exceeded limit). Possible infinite loop in code.",
            "status": "error",
            "execution_time": round((time.time() - start_time) * 1000, 2)
        }
    except Exception as e:
        return {
            "output": f"Execution Error: {str(e)}",
            "status": "error",
            "execution_time": round((time.time() - start_time) * 1000, 2)
        }
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

@app.get("/")
def root():
    return {
        "name": "SyncSpace Backend",
        "status": "online",
        "active_users": manager.get_user_count()
    }