const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"]
});
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgres://ride:ride@localhost:5432/ride"
});
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-this-secret";
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function tokenFor(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    req.user = jwt.verify(h.replace(/^Bearer /, ""), JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: "Não autenticado" });
  }
}

function role(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res.status(403).json({ error: "Perfil sem permissão" });
}

const socketsByUser = new Map();

function emitToUser(userId, event, payload) {
  const socketId = socketsByUser.get(Number(userId));
  if (socketId) io.to(socketId).emit(event, payload);
}

/* Entrega uma chamada ao motorista que estiver conectado.
   A gravação da corrida no banco é a fonte de verdade; Socket.IO é apenas
   o canal rápido. O endpoint /api/rides/offers e o polling do motorista
   garantem a entrega mesmo se o socket perder a mensagem. */
function notifyDriver(ride, driver) {
  if (!driver) return;
  emitToUser(driver.id, "ride:offer", {
    ...ride,
    driver_candidate: driver
  });
}

async function findNearestAvailableDriver(pickupLat, pickupLng) {
  const q = await pool.query(`
    SELECT u.id,u.name,u.rating,dl.lat,dl.lng,
      (6371 * acos(LEAST(1,
        cos(radians($1))*cos(radians(dl.lat))*
        cos(radians(dl.lng)-radians($2))+
        sin(radians($1))*sin(radians(dl.lat))
      ))) AS km
    FROM driver_locations dl
    JOIN users u ON u.id=dl.user_id
    WHERE dl.available=true AND u.role='driver'
    ORDER BY km ASC LIMIT 1
  `, [pickupLat, pickupLng]);
  return q.rows[0] || null;
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "ride-backend" });
  } catch (e) {
    res.status(503).json({ ok: false, error: "Banco indisponível" });
  }
});

app.post("/api/auth/register", async (req,res)=>{
  try {
    const {name,email,password,role:accountRole}=req.body;
    if(!name||!email||!password||!["passenger","driver"].includes(accountRole))
      return res.status(400).json({error:"Dados incompletos"});
    const hash=await bcrypt.hash(password,12);
    const q=await pool.query(
      `INSERT INTO users(name,email,password_hash,role)
       VALUES($1,$2,$3,$4)
       RETURNING id,name,email,role,rating`,
      [name,email.toLowerCase(),hash,accountRole]
    );
    const user=q.rows[0];
    res.json({user,token:tokenFor(user)});
  } catch(e) {
    res.status(400).json({
      error:e.code==="23505" ? "E-mail já cadastrado" : "Erro ao cadastrar"
    });
  }
});

app.post("/api/auth/login", async (req,res)=>{
  try {
    const {email,password}=req.body;
    const q=await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email?.toLowerCase()]
    );
    const user=q.rows[0];
    if(!user || !(await bcrypt.compare(password||"",user.password_hash)))
      return res.status(401).json({error:"E-mail ou senha inválidos"});
    res.json({
      user:{id:user.id,name:user.name,email:user.email,role:user.role,rating:user.rating},
      token:tokenFor(user)
    });
  } catch (e) {
    res.status(500).json({error:"Erro ao entrar"});
  }
});

app.post("/api/drivers/location",auth,role("driver"),async(req,res)=>{
  try {
    const {lat,lng,available=true}=req.body;
    if(!Number.isFinite(lat)||!Number.isFinite(lng))
      return res.status(400).json({error:"Localização inválida"});

    await pool.query(
      `INSERT INTO driver_locations(user_id,lat,lng,available)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(user_id) DO UPDATE
       SET lat=$2,lng=$3,available=$4,updated_at=NOW()`,
      [req.user.id,lat,lng,available]
    );

    // Se uma corrida foi criada antes de o motorista enviar o GPS,
    // tente fazer o matching agora.
    if (available) {
      const pending = await pool.query(`
        SELECT r.*
        FROM rides r
        WHERE r.status='searching'
          AND r.driver_id IS NULL
        ORDER BY r.id ASC
        LIMIT 20
      `);

      for (const ride of pending.rows) {
        const driver = await findNearestAvailableDriver(
          ride.pickup_lat, ride.pickup_lng
        );
        if (driver && Number(driver.id) === Number(req.user.id)) {
          notifyDriver(ride, driver);
        }
      }
    }

    res.json({ok:true});
  } catch (e) {
    console.error("driver location:", e);
    res.status(500).json({error:"Erro ao atualizar localização"});
  }
});

/* Fallback confiável: o motorista consulta as chamadas pendentes.
   Isso resolve perda de evento Socket.IO, recarga da página e corrida
   criada antes do motorista ficar online. */
app.get("/api/rides/offers", auth, role("driver"), async (req,res)=>{
  try {
    const q = await pool.query(`
      SELECT r.*, u.name AS passenger_name, u.rating AS passenger_rating,
        (6371 * acos(LEAST(1,
          cos(radians(r.pickup_lat))*cos(radians(dl.lat))*
          cos(radians(dl.lng)-radians(r.pickup_lng))+
          sin(radians(r.pickup_lat))*sin(radians(dl.lat))
        ))) AS km
      FROM rides r
      JOIN driver_locations dl ON dl.user_id=$1 AND dl.available=true
      JOIN users u ON u.id=r.passenger_id
      WHERE r.status='searching' AND r.driver_id IS NULL
      ORDER BY km ASC, r.id ASC
      LIMIT 10
    `, [req.user.id]);

    res.json({rides:q.rows});
  } catch (e) {
    console.error("ride offers:", e);
    res.status(500).json({error:"Erro ao buscar chamadas"});
  }
});

app.post("/api/rides",auth,role("passenger"),async(req,res)=>{
  try {
    const {pickup,destination,pickupLat,pickupLng,destLat,destLng}=req.body;

    if(!String(pickup||"").trim() ||
       !String(destination||"").trim() ||
       !Number.isFinite(pickupLat) ||
       !Number.isFinite(pickupLng)) {
      return res.status(400).json({
        error:"Origem/destino/localização obrigatórios"
      });
    }

    const q=await pool.query(
      `INSERT INTO rides(
         passenger_id,pickup,destination,pickup_lat,pickup_lng,dest_lat,dest_lng
       )
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        req.user.id,
        String(pickup).trim(),
        String(destination).trim(),
        pickupLat,pickupLng,
        Number.isFinite(destLat) ? destLat : null,
        Number.isFinite(destLng) ? destLng : null
      ]
    );

    const ride=q.rows[0];
    const nearest=await findNearestAvailableDriver(pickupLat,pickupLng);

    if (nearest) {
      ride.driver_candidate=nearest;
      notifyDriver(ride, nearest);
    }

    res.json({
      ride,
      driverCandidate: nearest || null
    });
  } catch (e) {
    console.error("create ride:", e);
    res.status(500).json({error:"Erro ao criar corrida"});
  }
});

app.get("/api/rides/active",auth,async(req,res)=>{
  try {
    const q=await pool.query(
      `SELECT r.*, u.name AS driver_name,u.rating AS driver_rating
       FROM rides r
       LEFT JOIN users u ON u.id=r.driver_id
       WHERE (r.passenger_id=$1 OR r.driver_id=$1)
         AND r.status NOT IN ('completed','cancelled')
       ORDER BY r.id DESC LIMIT 1`,
      [req.user.id]
    );
    res.json({ride:q.rows[0]||null});
  } catch (e) {
    res.status(500).json({error:"Erro ao consultar corrida"});
  }
});

app.post("/api/rides/:id/accept",auth,role("driver"),async(req,res)=>{
  const client=await pool.connect();
  try {
    await client.query("BEGIN");

    // Apenas um motorista consegue vencer esta atualização.
    const q=await client.query(
      `UPDATE rides
       SET driver_id=$1,status='accepted',updated_at=NOW()
       WHERE id=$2 AND status='searching' AND driver_id IS NULL
       RETURNING *`,
      [req.user.id,req.params.id]
    );

    if(!q.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({error:"Chamada já foi aceita"});
    }

    await client.query(
      "UPDATE driver_locations SET available=false WHERE user_id=$1",
      [req.user.id]
    );

    await client.query("COMMIT");

    const ride=q.rows[0];

    // Atualiza especificamente o passageiro e também mantém o broadcast
    // para compatibilidade com os clientes antigos.
    emitToUser(ride.passenger_id, "ride:update", {
      rideId:ride.id,
      status:"accepted",
      driverId:req.user.id,
      driverName:req.user.name
    });
    io.emit("ride:update", {
      rideId:ride.id,
      status:"accepted",
      driverId:req.user.id
    });

    res.json({ride});
  } catch(e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("accept:", e);
    res.status(500).json({error:"Erro ao aceitar"});
  } finally {
    client.release();
  }
});

app.post("/api/rides/:id/status",auth,async(req,res)=>{
  const allowed=["arrived","in_progress","completed","cancelled"];
  const {status}=req.body;

  if(!allowed.includes(status))
    return res.status(400).json({error:"Status inválido"});

  try {
    const q=await pool.query(
      `UPDATE rides SET status=$1,updated_at=NOW()
       WHERE id=$2 AND (passenger_id=$3 OR driver_id=$3)
       RETURNING *`,
      [status,req.params.id,req.user.id]
    );

    if(!q.rows[0])
      return res.status(404).json({error:"Corrida não encontrada"});

    const ride=q.rows[0];

    if(status==="completed" || status==="cancelled") {
      if (ride.driver_id) {
        await pool.query(
          "UPDATE driver_locations SET available=true WHERE user_id=$1",
          [ride.driver_id]
        );
      }
    }

    const event = {
      rideId:Number(req.params.id),
      status,
      driverId:ride.driver_id,
      passengerId:ride.passenger_id
    };

    if (ride.passenger_id) emitToUser(ride.passenger_id,"ride:update",event);
    if (ride.driver_id) emitToUser(ride.driver_id,"ride:update",event);
    io.emit("ride:update",event);

    res.json({ride});
  } catch(e) {
    console.error("ride status:", e);
    res.status(500).json({error:"Erro ao atualizar corrida"});
  }
});

io.on("connection",socket=>{
  socket.on("auth",token=>{
    try {
      const u=jwt.verify(token,JWT_SECRET);
      socket.user=u;

      const oldSocket=socketsByUser.get(Number(u.id));
      if(oldSocket && oldSocket !== socket.id) {
        const old=io.sockets.sockets.get(oldSocket);
        if(old) old.disconnect(true);
      }

      socketsByUser.set(Number(u.id),socket.id);
      socket.join(`user:${u.id}`);

      // Ao autenticar, avise imediatamente se houver chamada pendente.
      if (u.role === "driver") {
        pool.query(`
          SELECT r.*
          FROM rides r
          JOIN driver_locations dl ON dl.user_id=$1 AND dl.available=true
          WHERE r.status='searching' AND r.driver_id IS NULL
          ORDER BY r.id ASC
          LIMIT 10
        `,[u.id]).then(q=>{
          q.rows.forEach(ride=>notifyDriver(ride,{id:u.id}));
        }).catch(()=>{});
      }
    } catch(e) {
      socket.emit("ride:error",{error:"Sessão Socket.IO inválida"});
    }
  });

  socket.on("disconnect",()=>{
    if(socket.user &&
       socketsByUser.get(Number(socket.user.id)) === socket.id) {
      socketsByUser.delete(Number(socket.user.id));
    }
  });
});

server.listen(PORT,()=>console.log(`Ride backend: http://localhost:${PORT}`));
