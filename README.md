# WhatsApp Scheduler

Outil de planification de messages WhatsApp pour les groupes Femina Adventure.

## Prerequis

- [Node.js](https://nodejs.org) v18 ou superieur
- Un numero WhatsApp (Business ou personnel)

## Installation

```bash
# Cloner le repo
git clone <url-du-repo>
cd whatsapp-scheduler

# Installer les dependances
npm install

# Configurer l'environnement
cp .env.example .env
```

## Lancement

### Windows
Double-cliquez sur `start.bat`

### Mac
Double-cliquez sur `start.command` (rendez-le executable au prealable avec `chmod +x start.command`)

### Manuel
```bash
npm start
```

L'interface s'ouvre sur **http://localhost:3000**.

## Premier lancement

1. Lancez l'application
2. Un QR code s'affiche dans l'interface
3. Ouvrez WhatsApp sur votre telephone > Appareils connectes > Connecter un appareil
4. Scannez le QR code
5. La session est sauvegardee : pas besoin de rescanner au prochain lancement

## Fonctionnalites

- **Nouveau message** : composez un message, selectionnez des groupes, envoyez immediatement ou programmez
- **File d'attente** : visualisez et gerez les messages programmes
- **Templates** : creez des modeles reutilisables avec variables (`{{prenom}}`, `{{destination}}`, etc.)
- **Historique** : consultez tous les envois avec filtres et export CSV
- **Pieces jointes** : PDF, images, videos (max 16 Mo/fichier)

## Configuration (.env)

| Variable | Description | Defaut |
|---|---|---|
| `PORT` | Port du serveur | 3000 |
| `TIMEZONE` | Fuseau horaire | Europe/Paris |
| `ANTI_SPAM_DELAY` | Delai entre envois (secondes) | 15 |

## Structure

```
src/
  server.js      # Serveur Express + API REST
  whatsapp.js    # Client whatsapp-web.js
  scheduler.js   # Planificateur (node-cron)
  database.js    # SQLite (messages, templates, logs)
  public/        # Interface web (HTML/CSS/JS)
```

## Avertissement

Cet outil utilise `whatsapp-web.js` qui simule WhatsApp Web. Ce n'est pas l'API officielle WhatsApp Business. Pour un usage raisonnable (quelques groupes, quelques messages par semaine), le risque est minimal. Ne pas utiliser pour du spam.

---

*ZILE SAS / Femina Adventure — 2026*
