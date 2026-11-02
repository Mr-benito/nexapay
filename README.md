# NexaPay

Micropaiements instantanés par canaux de paiement hors chaîne (EIP-712) — cas d'usage : accès Wi-Fi payé à la minute.

Projet du cours de Blockchain et cryptomonnaies — Master 1, Université de Kinshasa (UNIKIN). **Groupe 27.**

## Membres du groupe

- NDUBU LULE BENITO
- KAMBA KATANU NOÉ

## Objectifs

- Ouvrir un canal de paiement avec un dépôt sur la chaîne.
- Effectuer des paiements instantanés et gratuits par signatures hors chaîne (EIP-712).
- Fermer le canal de façon coopérative ou unilatérale, avec une période de contestation de 24 heures.
- Comparer le coût du canal à celui de transactions classiques.

## Liens

| Élément | Valeur |
|---|---|
| Application en ligne | https://nexapay-one.vercel.app/ |
| Dépôt GitHub | https://github.com/Mr-benito/nexapay |
| Réseau | Ethereum Sepolia (réseau de test) |
| Contrat WiFiChannel | `0x34E54c08b0F1e0d2a3f50Eef449cf4b90A6C4c86` |
| Compte fournisseur (démo) | `0xA32C0d77f35BB2b8ff80AC57761A10ECf1ccbE62` |
| Explorateur | https://sepolia.etherscan.io/address/0x34E54c08b0F1e0d2a3f50Eef449cf4b90A6C4c86 |

## Architecture

```
Client (MetaMask) ──signe des reçus EIP-712 (hors chaîne, gratuit)──▶ Fournisseur
        │                                                                  │
        └── openChannel (dépôt) ─▶ Contrat WiFiChannel ◀─ closeCooperative ─┘
                                   (Sepolia)            ou fermeture unilatérale
```

- **Sur la chaîne** : contrat `WiFiChannel.sol` (dépôts, vérification des signatures, états ouvert / en contestation / fermé, retraits).
- **Hors chaîne** : reçus signés EIP-712 avec montant cumulé croissant.
- **Interface** : HTML, CSS, JavaScript et ethers.js, déployée sur Vercel (tableau de bord, session Wi-Fi, laboratoire EIP-712, comparateur de coûts, console fournisseur).
- **Développement** : Hardhat (compilation, tests, déploiement).

## Fonctions du contrat

| Fonction | Rôle |
|---|---|
| `openChannel(address payee)` | crée un canal avec un dépôt ; identifiant unique via `channelCount` |
| `closeCooperative(...)` | le fournisseur ferme avec la dernière signature valide |
| `startUnilateralClose(...)` | démarre la fermeture unilatérale (contestation de 24 h) |
| `disputeWithSignature(...)` | soumet un reçu signé de montant plus élevé pendant la contestation |
| `finalizeUnilateralClose(...)` | distribue les fonds après 24 h |

## Installation

```bash
git clone https://github.com/Mr-benito/nexapay.git
cd nexapay
npm install
```

## Tests

```bash
npx hardhat test
```

Cinq tests : fermeture coopérative, refus d'un ancien reçu, rejet d'une signature tierce ou d'un montant supérieur au dépôt, contestation, identifiants de canal uniques.

| Opération | Gas |
|---|---|
| Ouverture d'un canal | 119 621 |
| Fermeture coopérative | 100 163 |
| Finalisation après contestation | 75 648 |

## Déploiement

```bash
npx hardhat run scripts/deploy.js --network sepolia
```

Les clés privées ne sont jamais dans le dépôt : utiliser un keystore chiffré ou des variables d'environnement (`.env` exclu par `.gitignore`).

## Démonstration

1. Connecter MetaMask sur Sepolia.
2. Ouvrir un canal (dépôt de 0,01 ETH de test) : transaction sur la chaîne.
3. Dans « Session Wi-Fi », signer plusieurs minutes : signatures hors chaîne, gratuites.
4. Dans « Laboratoire EIP-712 », afficher les données signées.
5. Le fournisseur ferme le canal avec le dernier reçu : transaction sur la chaîne.
6. Dans « Analyse des coûts », afficher la comparaison.

## Comparaison des coûts

Canal : 219 784 gas (ouverture + fermeture), constant. Transferts classiques : N × 21 000 gas. Seuil de rentabilité : environ 11 paiements. Économie : 82,6 % pour 60 minutes, 98,9 % pour 1 000 minutes.

## Limites et perspectives

- Canal unidirectionnel ; pas encore de serveur Node.js pour le fournisseur.
- Pas d'expiration permettant au client de récupérer son dépôt si le fournisseur ne ferme pas le canal.
- Perspectives : serveur du fournisseur sur Render, routeur Wi-Fi réel, canaux bidirectionnels, couche 2, audit Slither.

## Sécurité et éthique

Réseau de test uniquement, jetons sans valeur réelle, aucune donnée personnelle sur la chaîne, aucune clé privée publiée. Dépendances citées : Hardhat, ethers.js, OpenZeppelin, MetaMask.

## Captures d'écran

À ajouter dans `docs/` puis référencer ici.
