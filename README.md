# Ride V3 — Login + PostgreSQL + GPS + Matching

## O que foi adicionado

- Cadastro e login com perfis de **passageiro** e **motorista**.
- Senhas com hash bcrypt.
- JWT para autenticação.
- PostgreSQL persistente.
- Tabelas de usuários, localização dos motoristas e corridas.
- GPS do navegador para atualizar a posição do motorista.
- Matching inicial pelo motorista disponível mais próximo usando distância geográfica.
- Socket.IO para entregar a chamada ao motorista em tempo real.
- Fluxo: searching → accepted → arrived → in_progress → completed.

## Rodar com Docker

Requer Docker Desktop e Node.js 18+.

Terminal 1:
```bash
docker compose up -d
```

Terminal 2:
```bash
npm install
npm start
```

Abra:
- http://localhost:3000/
- depois crie uma conta de passageiro e uma de motorista em abas diferentes.

## Importante

Este é um ambiente de desenvolvimento. Troque `JWT_SECRET`, credenciais do banco e configure HTTPS antes de qualquer uso público. O cálculo de rota, pagamentos, KYC/documentos e antifraude ainda precisam de serviços próprios.
