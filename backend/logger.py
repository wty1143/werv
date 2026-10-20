import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
LOGS_DIR = BASE_DIR / "logs"
LOGS_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOGS_DIR / "backend.log"

logger = logging.getLogger("werv")
logger.setLevel(logging.DEBUG if os.getenv("DEBUG") == "1" else logging.INFO)

# Avoid duplicate handlers if reloaded
if not logger.handlers:
    formatter = logging.Formatter(
        "[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 1. Console Handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(formatter)
    logger.addHandler(ch)

    # 2. Rotating File Handler (10MB, up to 5 backups)
    try:
        fh = RotatingFileHandler(
            str(LOG_FILE),
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(formatter)
        logger.addHandler(fh)
    except Exception as e:
        sys.stderr.write(f"無法建立檔案日誌處理器 ({LOG_FILE}): {e}\n")


def get_logger(name: str = "werv") -> logging.Logger:
    return logging.getLogger(name)
