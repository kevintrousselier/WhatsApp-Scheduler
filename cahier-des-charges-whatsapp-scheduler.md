# Cahier des charges — WhatsApp Scheduler

> Outil desktop de planification de messages WhatsApp pour groupes  
> Projet : usage interne ZILE / Femina Adventure  
> Version : 1.0 — Avril 2026

---

## 1. Contexte & objectif

### Problème
Il n'existe pas de solution gratuite, cloud, permettant de planifier l'envoi de messages (texte + pièces jointes) dans des groupes WhatsApp sans que l'appareil de l'utilisateur soit allumé au moment de l'envoi.

### Solution
Développer un outil custom, hébergé sur GitHub, basé sur `whatsapp-web.js` (connexion via QR code, comme WhatsApp Web), avec un scheduler cloud qui envoie les messages de façon autonome.

### Cas d'usage principal
Planifier des batteries de messages (J-7, J-3, J-1, Jour J) à destination des groupes WhatsApp des participantes aux raids Femina Adventure (Corse, Guadeloupe, Maurice) : briefings, rappels d'équipement, documents officiels, liens d'inscription.

---

## 2. Contraintes techniques

| Critère | Valeur |
|---|---|
| Hébergement | GitHub + service cloud gratuit (Railway / Render / Fly.io) |
| Compatibilité OS | Mac + Windows |
| Appareil requis à l'envoi | ❌ Non — envoi 100% cloud |
| Numéro WhatsApp | 1 seul numéro connecté (WhatsApp Business) |
| Coût cible | 0€/mois |
| Accès | Solo (évolutif multi-utilisateurs en v2) |
| Lancement | 1 seul clic sur desktop |

### Stack technique recommandée
- **Runtime** : Node.js
- **Librairie WhatsApp** : `whatsapp-web.js` (connexion QR, gratuite, open-source)
- **Scheduler** : `node-cron`
- **Base de données** : SQLite (légère, fichier local, zéro infrastructure)
- **Interface** : application web locale (Express.js + frontend HTML/CSS/JS simple)
- **Hébergement du service** : Railway ou Render (plan gratuit)
- **Lancement 1 clic** : script shell + raccourci bureau (`.bat` Windows / `.command` Mac)

---

## 3. Fonctionnalités

### 3.1 Connexion WhatsApp
- Au premier lancement, affichage d'un QR code à scanner avec le téléphone
- Session persistante : pas besoin de re-scanner à chaque lancement
- Indicateur de statut de connexion visible dans l'interface (connecté / déconnecté)
- Reconnexion automatique en cas de perte de session

### 3.2 Gestion des groupes
- Chargement automatique de la liste de tous les groupes WhatsApp du numéro connecté
- Recherche / filtrage par nom de groupe
- Sélection d'un ou plusieurs groupes comme destinataires d'un message

### 3.3 Composition de messages
Deux modes disponibles :

**Mode saisie libre**
- Zone de texte (textarea) avec support du formatage WhatsApp (`*gras*`, `_italique_`, `~barré~`)
- Aperçu du message avant envoi

**Mode template**
- Bibliothèque de templates pré-enregistrés (ex : "Rappel J-7 Corse", "Briefing équipement Maurice")
- Création, édition, suppression de templates
- Variables dynamiques supportées : `{{prenom}}`, `{{groupe}}`, `{{date_raid}}`, `{{destination}}`
- Sélection d'un template pré-remplit le formulaire (modifiable avant envoi)

### 3.4 Pièces jointes
Types supportés :
- **PDF** (briefings, règlements, conventions partenariat)
- **Images** (JPG, PNG — visuels raid, roll-ups)
- **Vidéos** (MP4)
- **Liens** (inclus dans le corps du message)

Contraintes :
- Taille max par fichier : 16 Mo (limite WhatsApp)
- Glisser-déposer ou sélection via explorateur de fichiers
- Aperçu du fichier avant envoi

### 3.5 Planification
- Sélection de la date et heure d'envoi via un date-picker
- Fuseau horaire configurable (Europe/Paris par défaut)
- Envoi immédiat possible (bouton "Envoyer maintenant")
- File d'attente des messages programmés visible dans l'interface
- Modification / suppression d'un message programmé avant son envoi
- Délai minimum entre messages d'une même campagne configurable (anti-spam : 10–60 secondes)

### 3.6 Historique des envois
- Log de tous les messages envoyés : date, heure, groupe(s) destinataire(s), statut (✅ envoyé / ❌ erreur)
- Aperçu du contenu du message envoyé
- Filtrage par date, groupe, statut
- Export CSV de l'historique

### 3.7 Lancement 1 clic
- **Mac** : fichier `.command` sur le bureau → lance le serveur Node.js + ouvre automatiquement l'interface dans le navigateur par défaut
- **Windows** : fichier `.bat` sur le bureau → même comportement
- L'interface s'ouvre à l'adresse `http://localhost:3000`
- Arrêt propre via un bouton dans l'interface ou fermeture du terminal

---

## 4. Interface utilisateur

### 4.1 Structure de l'interface
Application web monopage (SPA) accessible en local, organisée en 4 sections via une navigation latérale :

```
┌─────────────────────────────────────────────┐
│  LOGO / NOM          [Statut WhatsApp ●]    │
├──────────┬──────────────────────────────────┤
│          │                                  │
│ Navigation│        Zone principale           │
│          │                                  │
│ 📝 Nouveau│                                  │
│ 📋 File   │                                  │
│ 📚 Templates│                                │
│ 🕓 Historique│                               │
│          │                                  │
└──────────┴──────────────────────────────────┘
```

### 4.2 Écran "Nouveau message"
1. Sélection du/des groupe(s) destinataire(s)
2. Choix du mode (saisie libre ou template)
3. Rédaction / composition du message
4. Ajout de pièces jointes
5. Choix : "Envoyer maintenant" ou "Programmer"
6. Si programmé : sélection date + heure
7. Bouton "Confirmer"

### 4.3 Écran "File d'attente"
- Liste des messages programmés (triés chronologiquement)
- Pour chaque message : groupe, date prévue, aperçu du contenu, pièce jointe si applicable
- Actions : modifier, supprimer

### 4.4 Écran "Templates"
- Grille des templates existants
- Bouton "Nouveau template"
- Pour chaque template : titre, aperçu, actions (éditer, dupliquer, supprimer)

### 4.5 Écran "Historique"
- Tableau chronologique des envois
- Colonnes : date/heure, groupe, message (aperçu), statut, pièce jointe
- Filtres et export CSV

---

## 5. Sécurité & fiabilité

- Session WhatsApp stockée localement (chiffrée) — ne transite pas sur GitHub
- Le fichier `.env` (clés, config) est dans `.gitignore`
- Reconnexion automatique si perte de connexion WhatsApp
- En cas d'échec d'envoi : retry automatique (3 tentatives espacées de 30s), puis log erreur
- Pas de données personnelles des participantes stockées dans l'outil

---

## 6. Avertissement d'usage

`whatsapp-web.js` ne passe pas par l'API officielle WhatsApp Business. L'outil simule WhatsApp Web. Techniquement contraire aux CGU de WhatsApp, mais massivement utilisé. Pour un usage raisonné (quelques groupes, quelques messages par semaine), le risque de bannissement est très faible. À ne pas utiliser pour du spam ou de l'envoi massif non sollicité.

---

## 7. Phases de développement

### Phase 1 — MVP (prioritaire)
- [ ] Connexion WhatsApp via QR
- [ ] Chargement des groupes
- [ ] Composition message texte + lien
- [ ] Envoi immédiat
- [ ] Planification basique (date + heure)
- [ ] Lancement 1 clic Mac + Windows

### Phase 2 — Complet
- [ ] Pièces jointes (PDF, image, vidéo)
- [ ] Système de templates + variables
- [ ] File d'attente visible + éditable
- [ ] Historique des envois + export CSV
- [ ] Anti-spam (délai entre messages)

### Phase 3 — Évolutif (v2)
- [ ] Multi-utilisateurs (login simple)
- [ ] Multi-numéros WhatsApp
- [ ] Récurrence (envoi hebdomadaire / mensuel)
- [ ] Notifications d'envoi par email

---

## 8. Livrables attendus

| Livrable | Description |
|---|---|
| `README.md` | Installation, lancement, usage |
| `install.sh` / `install.bat` | Script d'installation automatique (Node.js check + npm install) |
| `start.command` (Mac) | Lancement 1 clic Mac |
| `start.bat` (Windows) | Lancement 1 clic Windows |
| Code source complet | Déposé sur repository GitHub privé |
| `.env.example` | Template de configuration |

---

## 9. Repository GitHub

- **Visibilité** : Privé
- **Structure suggérée** :
```
whatsapp-scheduler/
├── src/
│   ├── server.js         # Express + API routes
│   ├── whatsapp.js       # Connexion whatsapp-web.js
│   ├── scheduler.js      # node-cron jobs
│   ├── database.js       # SQLite (messages, templates, logs)
│   └── public/           # Interface HTML/CSS/JS
├── data/                 # SQLite DB + session WhatsApp (gitignored)
├── uploads/              # Pièces jointes temporaires (gitignored)
├── .env.example
├── .gitignore
├── package.json
├── start.command
├── start.bat
└── README.md
```

---

*Cahier des charges rédigé en avril 2026 — ZILE SAS / Femina Adventure*
