# Fork HomeLab

- Fork : https://github.com/iitsGaMa/ccs
- Source officielle (`upstream`) : https://github.com/kaitranntt/ccs
- Branche maintenue : `homelab`, issue de `upstream/dev` conformément au guide du projet.
- Correctif : lire les limites Claude nommées et leurs modèles, ignorer les champs internes non identifiés.

## Intégrer une mise à jour

Partir d'un arbre de travail propre. `origin` désigne le fork ; `upstream` le projet officiel.

```sh
git switch homelab
git fetch upstream --tags
git switch -c update/ccs-upstream
git merge upstream/dev
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test tests/unit/cliproxy/claude-named-limits.test.ts
git push -u origin HEAD
```

Résoudre les conflits et vérifier les changements avant de fusionner dans `homelab`.
Pour une promotion stable, comparer également le tag officiel retenu : `dev` peut
contenir des nouveautés non publiées. Ne jamais utiliser « Sync fork / discard changes »
pour remplacer la branche personnalisée.

## Construire

Le workflow manuel **Homelab build**, lancé sur `homelab`, produit une image Docker
Debian depuis le code du fork et un artefact `ccs-homelab-<commit>` téléchargeable.
Il ne publie ni paquet npm ni release, et ne déploie rien.

```sh
docker build -f docker/Dockerfile.homelab -t ccs-homelab:$(git rev-parse HEAD) .
```

Pour installer ultérieurement : charger l'archive avec `docker load`, sélectionner
son tag exact dans Dokploy, conserver les volumes et ports de la stack existante,
puis déployer. Garder l'ancienne image pour le retour arrière. Ne pas exécuter
`ccs update` dans cette image : reconstruire le fork après fusion des nouveautés.

Aucun compte, cookie, jeton ou fichier de configuration réel ne doit entrer dans Git.
Les workflows de publication upstream restent désactivés dans les réglages du fork ;
seul **Homelab build** est activé. La CI lit des fixtures, jamais les comptes du homelab.

## Historique du proxy

`GET /api/bar/account-history` utilise l'authentification existante du dashboard.
La réponse expose uniquement les totaux quotidiens UTC sur 30 jours, par compte
attribué par CLIProxy : tokens entrée/sortie/cache, requêtes et estimation API.
Les requêtes échouées et sans attribution sont exclues. Les dates du premier et
du dernier enregistrement indiquent la couverture. Ce n'est pas la facturation
d'un abonnement ni un historique complet des usages directs chez Claude.
