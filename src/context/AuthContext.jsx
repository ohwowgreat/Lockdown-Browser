import React, { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [teacher, setTeacher] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) { setLoading(false); return }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.teacher) setTeacher(data.teacher)
        else localStorage.removeItem('token')
      })
      .finally(() => setLoading(false))
  }, [])

  function login(token, teacherData) {
    localStorage.setItem('token', token)
    setTeacher(teacherData)
  }

  function logout() {
    localStorage.removeItem('token')
    setTeacher(null)
  }

  function authHeaders() {
    const token = localStorage.getItem('token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  // Raw token, for transports that can't carry an Authorization header
  // (the Socket.IO monitor join).
  function getToken() {
    return localStorage.getItem('token')
  }

  return (
    <AuthContext.Provider value={{ teacher, loading, login, logout, authHeaders, getToken }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
