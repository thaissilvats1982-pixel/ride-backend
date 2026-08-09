const express=require("express");
const cors=require("cors");
const http=require("http");
const {Server}=require("socket.io");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");

const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:"*",methods:["GET","POST"]}});
const PORT=process.env.PORT||10000;
const JWT_SECRET=process.env.JWT_SECRET||"change-this-secret";

app.use(cors({origin:"*"}));
app.use(express.json());

const users=[];
const rides=[];

const makeToken=u=>jwt.sign({id:u.id,email:u.email,role:u.role},JWT_SECRET,{expiresIn:"7d"});

function auth(req,res,next){
  const h=req.headers.authorization||"";
  const t=h.startsWith("Bearer ")?h.slice(7):null;
  if(!t)return res.status(401).json({error:"Token não informado"});
  try{req.user=jwt.verify(t,JWT_SECRET);next();}
  catch(e){res.status(401).json({error:"Token inválido ou expirado"});}
}

app.get("/",(req,res)=>res.json({app:"Ride Backend",status:"online"}));
app.get("/api/health",(req,res)=>res.json({ok:true}));

app.post("/api/auth/register",async(req,res)=>{
  const {name,email,password,role="passenger"}=req.body||{};
  if(!name||!email||!password)return res.status(400).json({error:"Nome, e-mail e senha são obrigatórios"});
  if(!["passenger","driver"].includes(role))return res.status(400).json({error:"Perfil inválido"});
  const e=String(email).trim().toLowerCase();
  if(users.some(u=>u.email===e))return res.status(409).json({error:"E-mail já cadastrado"});
  const u={id:String(Date.now()),name:String(name).trim(),email:e,passwordHash:await bcrypt.hash(String(password),10),role};
  users.push(u);
  res.status(201).json({user:{id:u.id,name:u.name,email:u.email,role:u.role},token:makeToken(u)});
});

app.post("/api/auth/login",async(req,res)=>{
  const e=String(req.body?.email||"").trim().toLowerCase();
  const u=users.find(x=>x.email===e);
  if(!u||!(await bcrypt.compare(String(req.body?.password||""),u.passwordHash)))
    return res.status(401).json({error:"E-mail ou senha inválidos"});
  res.json({user:{id:u.id,name:u.name,email:u.email,role:u.role},token:makeToken(u)});
});

app.get("/api/me",auth,(req,res)=>{
  const u=users.find(x=>x.id===req.user.id);
  if(!u)return res.status(404).json({error:"Usuário não encontrado"});
  res.json({id:u.id,name:u.name,email:u.email,role:u.role});
});

app.post("/api/rides",auth,(req,res)=>{
  if(req.user.role!=="passenger")return res.status(403).json({error:"Somente passageiro"});
  const {pickup,destination,price=13.13}=req.body||{};
  if(!pickup||!destination)return res.status(400).json({error:"Origem e destino são obrigatórios"});
  const r={id:String(Date.now()),passengerId:req.user.id,pickup,destination,price:Number(price),status:"requested",createdAt:new Date().toISOString()};
  rides.push(r); io.to("drivers").emit("ride:new",r); res.status(201).json(r);
});

app.get("/api/rides",auth,(req,res)=>{
  res.json(req.user.role==="driver"?rides:rides.filter(r=>r.passengerId===req.user.id));
});

app.post("/api/rides/:id/accept",auth,(req,res)=>{
  if(req.user.role!=="driver")return res.status(403).json({error:"Somente motorista"});
  const r=rides.find(x=>x.id===req.params.id);
  if(!r)return res.status(404).json({error:"Corrida não encontrada"});
  if(r.status!=="requested")return res.status(409).json({error:"Corrida não disponível"});
  r.driverId=req.user.id;r.status="accepted";io.emit("ride:updated",r);res.json(r);
});

app.post("/api/rides/:id/start",auth,(req,res)=>{
  const r=rides.find(x=>x.id===req.params.id);
  if(!r)return res.status(404).json({error:"Corrida não encontrada"});
  r.status="started";io.emit("ride:updated",r);res.json(r);
});

app.post("/api/rides/:id/finish",auth,(req,res)=>{
  const r=rides.find(x=>x.id===req.params.id);
  if(!r)return res.status(404).json({error:"Corrida não encontrada"});
  r.status="finished";r.finishedAt=new Date().toISOString();io.emit("ride:updated",r);res.json(r);
});

io.on("connection",socket=>{
  socket.on("driver:online",()=>socket.join("drivers"));
});

server.listen(PORT,"0.0.0.0",()=>console.log("Ride Backend na porta "+PORT));
