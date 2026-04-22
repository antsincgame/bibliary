#!/usr/bin/env bash
# Bibliary Forge — WSL bootstrap script (Phase 3.3).
#
# Устанавливает venv + unsloth + deps в ~/bibliary-forge/.
# Идемпотентен: повторный запуск ничего не сломает.
#
# Usage: wsl bash /mnt/c/Users/.../setup-wsl.sh
set -e

WORKDIR="${HOME}/bibliary-forge"
VENV="${WORKDIR}/.venv"

echo ">>> Bibliary Forge WSL bootstrap"
echo ">>> Workdir: ${WORKDIR}"

# 1. python3-venv
if ! dpkg -s python3-venv >/dev/null 2>&1; then
  echo ">>> Installing python3-venv (sudo required)"
  sudo apt update -y
  sudo apt install -y python3-venv python3-pip git
fi

# 2. workdir
mkdir -p "${WORKDIR}"
cd "${WORKDIR}"

# 3. venv
if [ ! -d "${VENV}" ]; then
  echo ">>> Creating venv ${VENV}"
  python3 -m venv "${VENV}"
fi

# 4. activate + install
# shellcheck disable=SC1091
source "${VENV}/bin/activate"
python -m pip install --upgrade pip wheel

# Для CUDA 12.x — torch 2.4+
echo ">>> Installing torch + unsloth (это может занять 10-15 мин)"
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install -U "unsloth @ git+https://github.com/unslothai/unsloth.git"
pip install -U trl peft accelerate bitsandbytes datasets transformers

# 5. quick smoke test
echo ">>> Smoke test"
python -c "import unsloth; print('unsloth', unsloth.__version__)" || {
  echo "!!! unsloth import failed"
  exit 1
}

echo ">>> Done. Venv at ${VENV}"
echo ">>> Activate: source ${VENV}/bin/activate"
