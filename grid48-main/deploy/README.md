# Grid 48 — Deploy no Raspberry Pi 3B+

Este é o guia oficial de sobrevivência para subir o Nó Base (Ipiranga) do Grid 48 num Raspberry Pi 3B+ pela primeira vez.

## Checklist de Instalação (Fase 4)

1. **Flash do SO**
   - Instale o **Raspberry Pi OS Lite (64-bit)** no cartão SD.
   - Ative o SSH na configuração do imager.

2. **Acesso e Dependências Iniciais**
   ```bash
   ssh pi@grid48.local
   sudo apt update && sudo apt upgrade -y
   ```

3. **Instalação do Docker**
   ```bash
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   sudo usermod -aG docker $USER
   # Saia e entre no SSH novamente
   ```

4. **Preparação do Pendrive (Proteção do SD Card)**
   - O banco SQLite WAL desgasta muito o cartão SD. Use um pendrive USB para os dados do Engine.
   ```bash
   sudo mkdir -p /mnt/usb/grid48
   # Descubra o ID do pendrive com: lsblk
   # Formate (CUIDADO): sudo mkfs.ext4 /dev/sda1
   # Monte no fstab:
   echo '/dev/sda1 /mnt/usb/grid48 ext4 defaults 0 2' | sudo tee -a /etc/fstab
   sudo mount -a
   sudo chown -R $USER:$USER /mnt/usb/grid48
   ```

5. **Regras UDEV do Rádio LoRa**
   - Para que o Node.js encontre o rádio sem precisar de root, injetamos regras UDEV.
   ```bash
   sudo cp deploy/udev/99-grid48-radio.rules /etc/udev/rules.d/
   sudo udevadm control --reload-rules
   sudo udevadm trigger
   ```

6. **Deploy via Docker Compose**
   ```bash
   cd grid48-main/docker
   # Crie um arquivo .env com suas chaves:
   # echo "CONVEX_GW_URL=xxx" > .env
   # echo "PSK_GATEWAY=xxx" >> .env
   
   docker compose pull
   docker compose up -d
   ```

7. **Verificação de Saúde**
   - Frontend: `http://<ip-do-pi>/`
   - Engine API: `http://<ip-do-pi>:3001/api/health`
