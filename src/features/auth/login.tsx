"use client";
import { AppHeader } from "../navigation/app-header";
import { FormEvent, useEffect, useState } from "react";
import { getSession, signInWithPassword, signUpWithPassword } from "./client";
import { safeReturnTo } from "./return-to";
import "./auth.css";

export function Login() {
  const [mode,setMode]=useState<"sign-in"|"sign-up">("sign-in"),[name,setName]=useState(""),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{getSession().then(user=>{if(user)location.replace(safeReturnTo(new URLSearchParams(location.search).get("returnTo"),location.origin));}).catch(()=>setError("Не удалось проверить вход. Можно попробовать войти ниже."));},[]);
  async function submit(event:FormEvent){event.preventDefault();setBusy(true);setError("");try{if(mode==="sign-up")await signUpWithPassword(name,email,password);else await signInWithPassword(email,password);const target=new URLSearchParams(location.search).get("returnTo");location.replace(safeReturnTo(target,location.origin));}catch(e){setError(e instanceof Error?e.message:"Не удалось войти.");}finally{setBusy(false);}}
  function switchMode(){setMode(current=>current==="sign-in"?"sign-up":"sign-in");setError("");}
  return <main className="ui-page"><AppHeader /><section className="auth-card"><p className="kicker">Личный кабинет</p><h1>{mode==="sign-in"?"Вход":"Регистрация"}</h1><p>{mode==="sign-in"?"Войдите, чтобы открыть свои прогулки и сохранённые истории.":"Создайте аккаунт, чтобы сохранять прогулки и открывать их на других устройствах."}</p><form onSubmit={submit}>{mode==="sign-up"&&<label>Имя<input required autoComplete="name" maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label>}<label>Email<input required autoComplete="email" type="email" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Пароль<input required autoComplete={mode==="sign-in"?"current-password":"new-password"} type="password" minLength={10} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label>{mode==="sign-up"&&<p className="auth-hint">Не менее 10 символов. Восстановление пароля пока недоступно.</p>}{error&&<p role="alert" className="form-error">{error}</p>}<button disabled={busy} className="account-button">{busy?"Подождите…":mode==="sign-in"?"Войти":"Создать аккаунт"}</button></form><button type="button" className="text-button" onClick={switchMode}>{mode==="sign-in"?"Нет аккаунта? Зарегистрироваться":"Уже есть аккаунт? Войти"}</button></section></main>;
}
